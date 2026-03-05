import fs from "node:fs/promises";
import path from "node:path";
import { CodegenPlugin, Types } from "@graphql-codegen/plugin-helpers";
import { generate } from "@graphql-codegen/cli";
import * as typescriptPlugin from "@graphql-codegen/typescript";
import * as openctiClientPlugin from "./generate-opencti-client-plugin";
import yaml from "yaml";

(async () => {
    if (!process.argv[2]) {
        console.error(`[!] Usage: pnpm run generate [path to opencti]`);
        return;
    }

    const cwd = process.cwd();

    const opencti = await fs.realpath(process.argv[2]);

    const openctiGraphql = path.join(opencti, "opencti-platform", "opencti-graphql");
    const packageJson = JSON.parse(await fs.readFile(path.join(openctiGraphql, "package.json"), { encoding: "utf-8" }));
    const graphqlCodegen = yaml.parse(
        await fs.readFile(path.join(openctiGraphql, "graphql-codegen.yml"), { encoding: "utf-8" }),
    ) as Types.Config;

    console.log(`[+] generating client for opencti version ${packageJson["version"]}`);

    delete graphqlCodegen.generates["./graphql.schema.json"];
    const outputConfig = graphqlCodegen.generates["src/generated/graphql.ts"] as Types.ConfiguredOutput;
    outputConfig.plugins = ["typescript", "opencti-client-generator"];
    outputConfig.config = {
        ...outputConfig.config,
        enumsAsTypes: true,
        jsonOutputDir: path.join(cwd, "src", "generated"),
    };

    graphqlCodegen.pluginLoader = async (name: string): Promise<CodegenPlugin> => {
        if (name === "@graphql-codegen/typescript") return typescriptPlugin;
        if (name === "@graphql-codegen/opencti-client-generator") return openctiClientPlugin;

        throw new Error(`unresolved plugin ${name}`);
    };

    graphqlCodegen.hooks = {
        beforeAllFileWrite: () => {
            process.chdir(cwd);
        },
    };

    process.chdir(openctiGraphql);
    await generate(graphqlCodegen);
})();
