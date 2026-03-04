import { getBaseType } from "@graphql-codegen/plugin-helpers";
import * as TypescriptPlugin from "@graphql-codegen/typescript";
import {
    GraphQLField,
    GraphQLObjectType,
    GraphQLOutputType,
    isCompositeType,
    isEnumType,
    isObjectType,
    isScalarType,
    isUnionType,
} from "graphql";
import { shouldIgnoreField, wrapTypeScriptType } from "./type-processor";

export type OpNode = {
    doc: string;
    name?: string;
    returnType: string;
    argsType?: string;
    children: Record<string, OpNode>;
};

export type OpNodeJSON = {
    doc: string;
    name?: string;
    children?: Record<string, OpNodeJSON>;
};

export class OperationProcessor {
    visitor: TypescriptPlugin.TsVisitor;
    public gqlDocuments: Record<string, string> = {};

    // Root operation tree: key is the root method name (e.g. "region", "threatActorGroupEdit")
    public operationTree: Record<string, OpNode> = {};

    // Track used function names for collision detection
    private usedNames = new Set<string>();

    constructor(visitor: TypescriptPlugin.TsVisitor) {
        this.visitor = visitor;
    }

    private isNestedOperation(
        rootType: "Query" | "Mutation",
        field: GraphQLField<any, any>,
    ): field is GraphQLField<any, any> & { type: GraphQLObjectType } {
        if (!isObjectType(field.type)) return false;

        if (rootType === "Mutation") return field.type.name.endsWith("Mutations");

        return true;
    }

    private generateFullSelectionForType(type: GraphQLOutputType): string {
        const baseType = getBaseType(type);

        if (isUnionType(baseType)) {
            return `{ ${baseType
                .getTypes()
                .map((type) => `... on ${type.name} ${this.generateFullSelectionForType(type)}`)
                .join(" ")} }`;
        }

        if (isCompositeType(baseType)) {
            return `{ ...${this.visitor.convertName(baseType.name)}_All }`;
        }

        return "";
    }

    private generateFieldMetadata(rootType: "Query" | "Mutation", fields: GraphQLField<any, any>[]) {
        const typescriptParamTypes = fields.map((field, idx) => {
            const hasVariables = field.args.length > 0;

            const typeName =
                (idx === 0 ? rootType : (fields[idx - 1].type as GraphQLObjectType<any, any>).name) +
                (this.visitor.config.addUnderscoreToArgsType ? "_" : "") +
                this.visitor.convertName(field.name, {
                    useTypesPrefix: false,
                    useTypesSuffix: false,
                }) +
                "Args";

            const valuesSpread = field.args.map((arg) => {
                return {
                    gqlField: field.name,
                    gqlArg: arg.name,
                    gqlVariableName: `${field.name}_${arg.name}`,
                    gqlType: arg.type.toString(),
                };
            });

            const gqlBodyArgs = valuesSpread
                .map((v) => {
                    return `${v.gqlArg}: $${v.gqlVariableName}`;
                })
                .join(", ");

            let gqlBodyPrefix = `${field.name}${gqlBodyArgs ? `(${gqlBodyArgs})` : ""}`;
            let gqlBodySuffix = ``;

            if (idx !== fields.length - 1) {
                gqlBodyPrefix += ` {`;
                gqlBodySuffix += `}`;
            } else {
                gqlBodyPrefix += this.generateFullSelectionForType(field.type);
            }

            return {
                variableInfo: hasVariables
                    ? {
                          typeName,
                          valuesSpread,
                      }
                    : undefined,
                gqlBodyPrefix,
                gqlBodySuffix,
            };
        });

        const hasVariables = typescriptParamTypes.map((v) => v.variableInfo).filter((v) => !!v);

        const gqlDocumentVariables = hasVariables
            .flatMap((v) => v.valuesSpread)
            .map((v) => `$${v.gqlVariableName}: ${v.gqlType}`)
            .join(", ");

        const gqlBody =
            typescriptParamTypes.map((v) => v.gqlBodyPrefix).join(" ") +
            typescriptParamTypes.map((v) => v.gqlBodySuffix).join(" ");

        return {
            requiredImports: hasVariables.map((v) => v.typeName),
            gqlDocumentVariables: gqlDocumentVariables ? `(${gqlDocumentVariables})` : "",
            gqlBody: gqlBody,
            argsTypes: typescriptParamTypes.map((v) => v.variableInfo?.typeName),
        };
    }

    public generateClientFunction(rootType: "Query" | "Mutation", fields: GraphQLField<any, any>[]) {
        const metadata = this.generateFieldMetadata(rootType, fields);

        const currentField = fields[fields.length - 1];

        if (currentField.name === "__typename") return;

        // check if we should generate functions for nested operations
        const isNested = this.isNestedOperation(rootType, currentField);
        if (isNested) {
            for (const childField of Object.values(currentField.type.getFields())) {
                if (rootType === "Query" && !shouldIgnoreField(currentField.type, childField)) continue;

                this.generateClientFunction(rootType, [...fields, childField]);
            }

            // we never want to generate a "select all" for mutations, because each leaf field is also a mutation
            if (rootType === "Mutation") {
                // Still create the namespace node for mutations (no doc, just children)
                this.ensureMutationNamespace(rootType, fields, metadata);
                return;
            }
        }

        const documentName = `${rootType}${fields.map((v) => this.visitor.convertName(v.name)).join("")}`;

        const baseType = getBaseType(currentField.type);
        const functionReturnType = wrapTypeScriptType(
            currentField.type,
            isScalarType(baseType)
                ? `Scalars["${baseType.name}"]["output"]`
                : isEnumType(baseType)
                  ? this.visitor.convertName(baseType.name)
                  : `${this.visitor.convertName(baseType.name)}_All`,
        );

        // Build GQL document (same as before)
        this.gqlDocuments[documentName] =
            `${rootType === "Query" ? "query" : "mutation"} ${metadata.gqlDocumentVariables} { ${metadata.gqlBody} }`;

        // Build the OpNode and attach it to the tree
        const levelIdx = fields.length - 1;
        const node: OpNode = {
            doc: documentName,
            returnType: functionReturnType,
            argsType: metadata.argsTypes[levelIdx],
            children: {},
        };

        if (fields.length === 1) {
            // Root operation
            let functionName = fields[0].name;

            if (functionName in this.operationTree && this.operationTree[functionName].doc === "") {
                // Namespace node already exists from children — merge into it
                const existing = this.operationTree[functionName];
                node.children = existing.children;
            } else if (this.usedNames.has(functionName)) {
                // True collision with a different field (e.g. query vs mutation with same name)
                node.name = functionName;
                functionName += rootType;
            }
            this.usedNames.add(functionName);

            this.operationTree[functionName] = node;
        } else {
            // Nested operation: attach to parent
            const rootName = this.getRootName(fields[0].name, rootType);
            this.ensureParentNodes(rootType, fields, metadata);
            const parent = this.getParentNode(rootName, fields);
            parent.children[currentField.name] = node;
        }
    }

    private getRootName(fieldName: string, rootType: "Query" | "Mutation"): string {
        // Check if we used the suffixed name due to collision
        const suffixed = fieldName + rootType;
        if (suffixed in this.operationTree) return suffixed;
        return fieldName;
    }

    private ensureMutationNamespace(
        rootType: "Query" | "Mutation",
        fields: GraphQLField<any, any>[],
        metadata: ReturnType<typeof this.generateFieldMetadata>,
    ) {
        if (fields.length !== 1) return;

        const fieldName = fields[0].name;
        let functionName = fieldName;
        if (this.usedNames.has(functionName) && !(functionName in this.operationTree)) {
            functionName += rootType;
        }
        this.usedNames.add(functionName);

        if (!(functionName in this.operationTree)) {
            this.operationTree[functionName] = {
                doc: "", // No document for mutation namespaces
                name: functionName !== fieldName ? fieldName : undefined,
                returnType: "",
                argsType: metadata.argsTypes[0],
                children: {},
            };
        }
    }

    private ensureParentNodes(
        rootType: "Query" | "Mutation",
        fields: GraphQLField<any, any>[],
        metadata: ReturnType<typeof this.generateFieldMetadata>,
    ) {
        // For nested operations, ensure all intermediate parent nodes exist
        const rootFieldName = fields[0].name;
        let functionName = rootFieldName;
        if (this.usedNames.has(functionName) && !(functionName in this.operationTree)) {
            functionName += rootType;
        }

        if (!(functionName in this.operationTree)) {
            this.usedNames.add(functionName);
            this.operationTree[functionName] = {
                doc: "",
                name: functionName !== rootFieldName ? rootFieldName : undefined,
                returnType: "",
                argsType: metadata.argsTypes[0],
                children: {},
            };
        }
    }

    private getParentNode(rootName: string, fields: GraphQLField<any, any>[]): OpNode {
        let current = this.operationTree[rootName];
        // Navigate to the parent of the last field
        for (let i = 1; i < fields.length - 1; i++) {
            current = current.children[fields[i].name];
        }
        return current;
    }

    /**
     * Generate chainable TypeScript interfaces and the interface-merged method signatures.
     */
    public generateChainableInterfaces(): string[] {
        const lines: string[] = [];
        const interfaceMethodLines: string[] = [];

        for (const [name, node] of Object.entries(this.operationTree)) {
            const hasChildren = Object.keys(node.children).length > 0;
            const hasDoc = node.doc !== "";

            if (hasChildren) {
                // Generate a chainable interface
                const ifaceName = this.toPascalCase(name) + "Chainable";
                const ifaceLines: string[] = [];

                if (hasDoc) {
                    // Can be awaited directly (e.g. Query types with "select all")
                    ifaceLines.push(`export interface ${ifaceName} extends PromiseLike<${node.returnType}> {`);
                } else {
                    // Mutation namespaces can't be awaited
                    ifaceLines.push(`export interface ${ifaceName} {`);
                }

                for (const [childName, childNode] of Object.entries(node.children)) {
                    const childHasChildren = Object.keys(childNode.children).length > 0;
                    const childArgsParam = childNode.argsType ? `args?: ${childNode.argsType}` : "";

                    if (childHasChildren) {
                        const childIfaceName = this.toPascalCase(name) + this.toPascalCase(childName) + "Chainable";
                        ifaceLines.push(`    ${childName}(${childArgsParam}): ${childIfaceName};`);
                        // Recursively generate child chainable interfaces
                        this.generateChildChainableInterface(lines, name + this.toPascalCase(childName), childNode);
                    } else {
                        ifaceLines.push(`    ${childName}(${childArgsParam}): PromiseLike<${childNode.returnType}>;`);
                    }
                }

                ifaceLines.push(`}`);
                lines.push(ifaceLines.join("\n"));

                // Interface merge method signature
                const rootArgsParam = node.argsType ? `args?: ${node.argsType}` : "";
                interfaceMethodLines.push(`    ${name}(${rootArgsParam}): ${ifaceName};`);
            } else if (hasDoc) {
                // Leaf operation — just returns PromiseLike
                const rootArgsParam = node.argsType ? `args?: ${node.argsType}` : "";
                interfaceMethodLines.push(`    ${name}(${rootArgsParam}): PromiseLike<${node.returnType}>;`);
            }
        }

        // Generate the interface merge
        if (interfaceMethodLines.length > 0) {
            lines.push(`export interface BaseOpenCTIClient {\n${interfaceMethodLines.join("\n")}\n}`);
        }

        return lines;
    }

    private generateChildChainableInterface(output: string[], prefix: string, node: OpNode) {
        const ifaceName = this.toPascalCase(prefix) + "Chainable";
        const hasDoc = node.doc !== "";
        const ifaceLines: string[] = [];

        if (hasDoc) {
            ifaceLines.push(`export interface ${ifaceName} extends PromiseLike<${node.returnType}> {`);
        } else {
            ifaceLines.push(`export interface ${ifaceName} {`);
        }

        for (const [childName, childNode] of Object.entries(node.children)) {
            const childHasChildren = Object.keys(childNode.children).length > 0;
            const childArgsParam = childNode.argsType ? `args?: ${childNode.argsType}` : "";

            if (childHasChildren) {
                const childIfaceName = this.toPascalCase(prefix + this.toPascalCase(childName)) + "Chainable";
                ifaceLines.push(`    ${childName}(${childArgsParam}): ${childIfaceName};`);
                this.generateChildChainableInterface(output, prefix + this.toPascalCase(childName), childNode);
            } else {
                ifaceLines.push(`    ${childName}(${childArgsParam}): PromiseLike<${childNode.returnType}>;`);
            }
        }

        ifaceLines.push(`}`);
        output.push(ifaceLines.join("\n"));
    }

    /**
     * Generate the operations.json content (strip TS-only fields).
     */
    public generateOperationsJSON(): Record<string, OpNodeJSON> {
        const result: Record<string, OpNodeJSON> = {};
        for (const [name, node] of Object.entries(this.operationTree)) {
            result[name] = this.toOpNodeJSON(node);
        }
        return result;
    }

    private toOpNodeJSON(node: OpNode): OpNodeJSON {
        const children: Record<string, OpNodeJSON> = {};
        for (const [k, v] of Object.entries(node.children)) {
            children[k] = this.toOpNodeJSON(v);
        }
        return {
            doc: node.doc,
            ...(node.name ? { name: node.name } : {}),
            ...(Object.keys(children).length > 0 ? { children } : {}),
        };
    }

    private toPascalCase(str: string): string {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }
}
