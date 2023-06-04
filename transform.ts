import {
  API,
  Collection,
  FileInfo,
  ImportSpecifier,
  JSCodeshift,
  Transform,
  Options as JSCodeshiftOptions,
  MemberExpression,
  Identifier,
} from "jscodeshift";

const hookNames = [
  "useQuery",
  "useMutation",
  "useAction",
  "usePaginatedQuery",
  "useQueries",
];

type Options = {
  convexApiAlias: string;
  functionPrefixes: string[];
  generatedApiImport: string;
};

const parseOptions = (options: JSCodeshiftOptions): Options => {
  return {
    convexApiAlias: options.convexApiAlias ?? "api",
    functionPrefixes: options.functionPrefixes ?? [],
    generatedApiImport:
      options.generatedApiImport ??
      "ADDED_BY_CODEMOD_REPLACE_ME_GENERATED_API_IMPORT",
  };
};

const transformReactCode: Transform = (
  file: FileInfo,
  api: API,
  options: JSCodeshiftOptions
) => {
  const parsedOptions = parseOptions(options);
  const j: JSCodeshift = api.jscodeshift;

  const source = j(file.source);

  let generatedApiImportPath = parsedOptions.generatedApiImport;

  // Mapping from imported hook name, => Array<aliased hook names>
  // e.g. `import { useQuery as useConvexQuery } => { useQuery: ["useConvexQuery"] }
  const hookAliases: Record<string, Set<string>> = new Proxy(
    {},
    {
      // Make it a default dict
      get: (target: any, name: string) =>
        name in target ? target[name] : new Set(),
    }
  );

  source.find(j.ImportDeclaration).replaceWith((p) => {
    const node = p.node;
    const importPath = node.source.value;
    if (typeof importPath !== "string") {
      return node;
    }
    if (!importPath.includes("/_generated/react")) {
      return node;
    }

    // find imports for `/_generated/react`
    const specifiers = node.specifiers ?? [];
    const newSpecifiers: typeof specifiers = [];
    for (const specifier of specifiers) {
      if (specifier.type !== "ImportSpecifier") {
        throw new Error(
          "Can only handle named imports like `import { useQuery }"
        );
      }
      // Track which hooks are imported and how they're aliased
      // e.g. import { useQuery as useConvexQuery }
      // Also remove them from this import
      const importedName = specifier.imported.name;
      if (hookNames.includes(importedName)) {
        const alias = specifier.local?.name ?? importedName;
        hookAliases[importedName] = hookAliases[importedName].add(alias);
      } else {
        newSpecifiers.push(specifier);
      }
    }
    // Grab the import path for `api` to match style
    generatedApiImportPath = importPath.replace(
      "/_generated/react",
      "/_generated/api"
    );

    // Either remove the import or add it back with the hooks stripped out
    if (newSpecifiers.length > 0) {
      return j.importDeclaration(newSpecifiers, node.source);
    } else {
      return null;
    }
  });

  // Construct `import { useQuery } from "convex/react";
  // Including any aliases previously there
  const specifiers: ImportSpecifier[] = [];
  for (const hookName in hookAliases) {
    for (const alias of hookAliases[hookName]) {
      specifiers.push(
        j.importSpecifier(j.identifier(hookName), j.identifier(alias))
      );
    }
  }

  if (specifiers.length > 0) {
    const convexReactImport = j.importDeclaration(
      specifiers,
      j.literal("convex/react")
    );
    source.get().node.program.body.unshift(convexReactImport);
  }

  replaceFunctionReferences(j, source, {
    ...parsedOptions,
    generatedApiImport: generatedApiImportPath,
  });
  return source.toSource();
};

const transformConvexCode: Transform = (
  file: FileInfo,
  api: API,
  options: JSCodeshiftOptions
) => {
  const parsedOptions = parseOptions(options);
  const j: JSCodeshift = api.jscodeshift;

  const source = j(file.source);

  let generatedApiImportPath = parsedOptions.generatedApiImport;

  source.find(j.ImportDeclaration).forEach((p) => {
    const node = p.node;
    const importPath = node.source.value;
    if (typeof importPath !== "string") {
      return;
    }
    if (!importPath.includes("/_generated/server")) {
      return;
    }

    // Grab the import path for `api` to match style
    // Assumes there's an import to `_generated/server` in the file already
    generatedApiImportPath = importPath.replace(
      "/_generated/server",
      "/_generated/api"
    );
  });

  replaceFunctionReferences(j, source, {
    ...parsedOptions,
    generatedApiImport: generatedApiImportPath,
  });

  return source.toSource();
};

const transformOtherCode: Transform = (
  file: FileInfo,
  api: API,
  options: JSCodeshiftOptions
) => {
  const parsedOptions = parseOptions(options);
  const j: JSCodeshift = api.jscodeshift;

  const source = j(file.source);

  let generatedApiImportPath = parsedOptions.generatedApiImport;

  replaceFunctionReferences(j, source, {
    ...parsedOptions,
    generatedApiImport: generatedApiImportPath,
  });

  return source.toSource();
};

const transform: Transform = (
  file: FileInfo,
  api: API,
  options: JSCodeshiftOptions
) => {
  switch (options.kind) {
    case "react":
      return transformReactCode(file, api, options);
    case "convex":
      return transformConvexCode(file, api, options);
    default:
      return transformOtherCode(file, api, options);
  }
};

// Replace string literals starting with one of `functionPrefixes`
// with `api.path.functionName` (e.g. `"messages:list"` to `api.messages.list`)
const replaceFunctionReferences = (
  j: JSCodeshift,
  source: Collection<any>,
  options: Options
) => {
  let replaced = false;
  source
    .find(j.Literal)
    .filter((literal) => {
      const value = literal.node.value;
      if (typeof value !== "string") {
        return false;
      }

      return options.functionPrefixes.some((p) => value.startsWith(p));
    })
    .replaceWith((literal) => {
      const value = literal.node.value as string;
      const [path, functionName] = value.split(":");
      const pathParts = path.split("/");
      pathParts.push(functionName === undefined ? "default" : functionName);
      replaced = true;
      return assembleMemberExpression(j, [
        options.convexApiAlias,
        ...pathParts,
      ]);
    });
  if (replaced) {
    // Add `import { api } from "../convex/_generated/api"`
    const generatedApiImport = j.importDeclaration(
      [
        j.importSpecifier(
          j.identifier("api"),
          j.identifier(options.convexApiAlias)
        ),
      ],
      j.stringLiteral(options.generatedApiImport)
    );
    source.get().node.program.body.unshift(generatedApiImport);
  }
};

// Join ["api", "messages", "list"] into the AST for `api.messages.list`
const assembleMemberExpression = (
  j: JSCodeshift,
  parts: string[]
): MemberExpression | Identifier => {
  if (parts.length === 0) {
    throw new Error("Must have at least one part");
  }

  if (parts.length === 1) {
    return j.identifier(parts[0]);
  }
  const last = parts.pop()!;
  return j.memberExpression(
    assembleMemberExpression(j, parts),
    j.identifier(last)
  );
};

export default transform;
export const parser = "tsx";
