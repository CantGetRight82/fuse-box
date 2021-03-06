import * as fs from "fs";
import * as path from "path";
import { Config } from "./../../Config";
import { File } from "../../core/File";
import { WorkFlowContext } from "../../core/WorkflowContext";
import { Plugin } from "../../core/WorkflowContext";
import { utils } from "realm-utils";
import { Concat, ensureUserPath, write, isStylesheetExtension } from "../../Utils";


export interface CSSPluginOptions {
    outFile?: { (file: string): string } | string;
    inject?: boolean | { (file: string): string }
    group?: string;
    minify?: boolean;
}

/**
 *
 *
 * @export
 * @class FuseBoxCSSPlugin
 * @implements {Plugin}
 */
export class CSSPluginClass implements Plugin {
    /**
     *
     *
     * @type {RegExp}
     * @memberOf FuseBoxCSSPlugin
     */
    public test: RegExp = /\.css$/;
    private minify = false;
    public options: CSSPluginOptions;

    constructor(opts: CSSPluginOptions = {}) {
        this.options = opts;

        if (opts.minify !== undefined) {
            this.minify = opts.minify;
        }
    }
    /**
     *
     *
     * @param {WorkFlowContext} context
     *
     * @memberOf FuseBoxCSSPlugin
     */
    public init(context: WorkFlowContext) {
        context.allowExtension(".css");
    }

    public bundleStart(context: WorkFlowContext) {

        let lib = path.join(Config.FUSEBOX_MODULES, "fsbx-default-css-plugin", "index.js");
        context.source.addContent(fs.readFileSync(lib).toString());
    }

    public inject(file: File, options: any, alternative?: boolean) {
        // Inject properties
        // { inject : path => path } -> customise automatic injection
        // { inject : false } -> do not inject anything. User will manually put the script tag
        // No inject at all, means automatic injection with default path
        const resolvedPath = utils.isFunction(options.inject)
            ? options.inject(file.info.fuseBoxPath) : file.info.fuseBoxPath;

        // noop the contents if a user wants to manually inject it
        const result = options.inject !== false ? `__fsbx_css("${resolvedPath}");` : "";
        if (alternative) {
            file.addAlternativeContent(result);
        } else {
            file.contents = result;
        }
    }

    public transformGroup(group: File) {

        const debug = (text: string) => group.context.debugPlugin(this, text);
        debug(`Start group transformation on "${group.info.fuseBoxPath}"`);

        let concat = new Concat(true, "", "\n");
        group.subFiles.forEach(file => {
            debug(`  -> Concat ${file.info.fuseBoxPath}`);
            concat.add(file.info.fuseBoxPath, file.contents, file.generateCorrectSourceMap());
        });

        let options = group.groupHandler.options || {};
        const cssContents = concat.content;

        // writing
        if (options.outFile) {
            let outFile = ensureUserPath(options.outFile);
            const bundleDir = path.dirname(outFile);
            const sourceMapsName = path.basename(outFile) + ".map";

            concat.add(null, `/*# sourceMappingURL=${sourceMapsName} */`);

            debug(`Writing ${outFile}`);
            return write(outFile, concat.content).then(() => {
                this.inject(group, options);
                // Writing sourcemaps
                const sourceMapsFile = ensureUserPath(path.join(bundleDir, sourceMapsName));
                return write(sourceMapsFile, concat.sourceMap);
            });
        } else {
            debug(`Inlining ${group.info.fuseBoxPath}`);
            const safeContents = JSON.stringify(cssContents.toString());
            group.addAlternativeContent(`__fsbx_css("${group.info.fuseBoxPath}", ${safeContents});`)
        }

        this.emitHMR(group);
    }
    public emitHMR(file: File) {
        let emitRequired = true;
        const bundle = file.context.bundle;
        // We want to emit CSS Changes only if an actual CSS file was changed.
        if (bundle && bundle.lastChangedFile) {
            emitRequired = isStylesheetExtension​​(bundle.lastChangedFile);
        }
        if (emitRequired) {
            file.context.sourceChangedEmitter.emit({
                type: "js",
                content: file.alternativeContent,
                path: file.info.fuseBoxPath,
            });
        }
    }
    /**
     *
     *
     * @param {File} file
     *
     * @memberOf FuseBoxCSSPlugin
     */
    public transform(file: File) {
        // no bundle groups here
        if (file.hasSubFiles()) {
            return;
        }

        const debug = (text: string) => file.context.debugPlugin(this, text);

        file.loadContents();


        let filePath = file.info.fuseBoxPath;

        let context = file.context;

        file.contents = this.minify ? this.minifyContents(file.contents) : file.contents;

        /**
         * Bundle many files into 1 file
         * Should not start with . or /
         *     e.g "bundle.css""
         * require("./a.css"); require("./b.css");
         *
         * 2 files combined will be written or inlined to "bundle.css"
         */
        if (this.options.group) {
            file.sourceMap = undefined;
            const bundleName = this.options.group;
            let fileGroup = context.getFileGroup(bundleName);
            if (!fileGroup) {
                fileGroup = context.createFileGroup(bundleName, file.collection, this);
            }
            // Adding current file (say a.txt) as a subFile
            fileGroup.addSubFile(file);
            debug(`  grouping -> ${bundleName}`)

            // Respect other plugins to override the output
            file.addAlternativeContent(`require("~/${bundleName}")`);
            return;
        }

        /**
         * An option just to write files to a specific path
         */
        let outFileFunction;
        if (this.options.outFile !== undefined) {
            if (!utils.isFunction(this.options.outFile)) {
                context.fatal(`Error in CSSConfig. outFile is expected to be a function that resolves a path`);
            } else {
                outFileFunction = this.options.outFile;
            }
        }

        if (outFileFunction) {
            const userPath = ensureUserPath(outFileFunction(file.info.fuseBoxPath));
            // reset the content so it won't get bundled

            this.inject(file, this.options, true);
            // writing ilfe
            return write(userPath, file.contents).then(() => {
                if (file.sourceMap) {
                    const fileDir = path.dirname(userPath);
                    const sourceMapPath = path.join(fileDir, path.basename(userPath) + ".map");
                    return write(sourceMapPath, file.sourceMap);
                }
            });
        } else {
            let safeContents = JSON.stringify(file.contents);
            file.sourceMap = undefined;

            file.addAlternativeContent(`__fsbx_css("${filePath}", ${safeContents})`);

            // We want to emit CSS Changes only if an actual CSS file was changed.
            this.emitHMR(file);
        }
    }

    private minifyContents(contents) {
        return contents.replace(/\s{2,}/g, " ").replace(/\t|\r|\n/g, "").trim();
    }
}

export const CSSPlugin = (opts?: CSSPluginOptions) => {
    return new CSSPluginClass(opts);
};
