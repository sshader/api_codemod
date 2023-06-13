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

// Imports to move from `/_generated/react` to `convex/react`
const generatedReactMembers = [
  "useQuery",
  "useMutation",
  "useAction",
  "usePaginatedQuery",
  "useQueries",
];

// Imports to move from `/_generated/server` to `convex/server`
const generatedServerMembers = ["cronJobs"];

type Options = {
  convexApiAlias: string;
  functionPrefixes: string[];
  generatedApiImport: string;
  generatedCodeImport: {
    path: string;
    members: string[];
    newImportPath: string;
  } | null;
};

const parseOptions = (options: JSCodeshiftOptions): Options => {
  const commonOptions = {
    convexApiAlias: options.convexApiAlias ?? "api",
    functionPrefixes: options.functionPrefixes ?? [],
    generatedApiImport:
      options.generatedApiImport ??
      "ADDED_BY_CODEMOD_REPLACE_ME_GENERATED_API_IMPORT",
  };
  switch (options.kind) {
    case "react": {
      return {
        ...commonOptions,

        generatedCodeImport: {
          path: "/_generated/react",
          members: generatedReactMembers,
          newImportPath: "convex/react",
        },
      };
    }
    case "server": {
      return {
        ...commonOptions,
        generatedCodeImport: {
          path: "/_generated/server",
          members: generatedServerMembers,
          newImportPath: "convex/server",
        },
      };
    }
    default: {
      return {
        ...commonOptions,
        generatedCodeImport: null,
      };
    }
  }
};

const transform: Transform = (
  file: FileInfo,
  api: API,
  options: JSCodeshiftOptions
) => {
  const parsedOptions = parseOptions(options);
  const j: JSCodeshift = api.jscodeshift;

  const source = j(file.source);

  let generatedApiImportPath = parsedOptions.generatedApiImport;

  // Mapping from imported name, => Set<aliased names>
  // e.g. `import { useQuery as useConvexQuery } => { useQuery: Set(["useConvexQuery"]) }
  const memberAliases: Record<string, Set<string>> = new Proxy(
    {},
    {
      // Make it a default dict
      get: (target: any, name: string) =>
        name in target ? target[name] : new Set(),
    }
  );

  const generatedCodeImport = parsedOptions.generatedCodeImport;
  if (generatedCodeImport === null) {
    replaceFunctionReferences(j, source, {
      ...parsedOptions,
      generatedApiImport: generatedApiImportPath,
    });
    return source.toSource();
  }

  source.find(j.ImportDeclaration).replaceWith((p) => {
    const node = p.node;
    const importPath = node.source.value;
    if (typeof importPath !== "string") {
      return node;
    }
    // Imports that aren't for generated code shouldn't be touched
    if (!importPath.includes(generatedCodeImport.path)) {
      return node;
    }

    // find imports for `/_generated/foo`
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
      if (generatedCodeImport.members.includes(importedName)) {
        const alias = specifier.local?.name ?? importedName;
        memberAliases[importedName] = memberAliases[importedName].add(alias);
      } else {
        newSpecifiers.push(specifier);
      }
    }
    // Grab the import path for `api` to match style
    generatedApiImportPath = importPath.replace(
      generatedCodeImport.path,
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
  for (const memberName in memberAliases) {
    for (const alias of memberAliases[memberName]) {
      specifiers.push(
        j.importSpecifier(j.identifier(memberName), j.identifier(alias))
      );
    }
  }

  if (specifiers.length > 0) {
    const convexReactImport = j.importDeclaration(
      specifiers,
      j.literal(generatedCodeImport.newImportPath)
    );
    source.get().node.program.body.unshift(convexReactImport);
  }

  replaceFunctionReferences(j, source, {
    ...parsedOptions,
    generatedApiImport: generatedApiImportPath,
  });
  return source.toSource();
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
    .find(j.CallExpression)
    .filter((callExpression) => {
      const callee = callExpression.node.callee;
      if (callee.type === "Identifier") {
        if (
          [
            ...generatedReactMembers,
            "runQuery",
            "runMutation",
            "runAction",
          ].includes(callee.name)
        ) {
          return true;
        }
      }
      if (callee.type === "MemberExpression") {
        if (callee.property.type === "Identifier") {
          if (
            [
              // actions
              "runQuery",
              "runMutation",
              "runAction",
              // scheduler
              "runAt",
              "runAfter",
              // optimistic updates
              "getQuery",
              "getAllQueries",
              "setQuery",
            ].includes(callee.property.name)
          ) {
            return true;
          }
        }
      }
      return false;
    })
    .replaceWith((callExpression) => {
      const args = callExpression.node.arguments;
      const modifiedArgs = args.map((argument) => {
        if (argument.type !== "StringLiteral" && argument.type !== "Literal") {
          return argument;
        }
        const value = argument.value;
        if (typeof value !== "string") {
          return argument;
        }
        const isFunctionReference =
          options.functionPrefixes.some(
            (p) => value.startsWith(`${p}:`) && !value.startsWith("http://")
          ) || options.functionPrefixes.includes(value);
        if (!isFunctionReference) {
          return argument;
        }
        const [path, functionName] = value.split(":");
        const pathParts = path.split("/");
        pathParts.push(functionName === undefined ? "default" : functionName);
        replaced = true;
        return assembleMemberExpression(j, [
          options.convexApiAlias,
          ...pathParts,
        ]);
      });
      return j.callExpression(callExpression.node.callee, modifiedArgs);
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
