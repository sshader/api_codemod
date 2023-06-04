import { parseArgs } from "node:util";
import * as fs from "fs";
import * as path from "node:path";
import { run as runJSCodeshift } from "jscodeshift/src/Runner";
import { execSync } from "node:child_process";

const getFunctionsDirName = (project: string) => {
  const convexJsonPath = path.join(project, "convex.json");
  if (!fs.existsSync(convexJsonPath)) {
    return "convex";
  }
  const convexJsonContents = JSON.parse(
    fs.readFileSync(convexJsonPath, { encoding: "utf-8" })
  );
  const functionDir = convexJsonContents["functions"];
  return functionDir === undefined ? "convex" : functionDir;
};

const walkSync = (dir: string, callback: (f: string) => void) => {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    var filepath = path.join(dir, file);
    const stats = fs.statSync(filepath);
    if (stats.isDirectory()) {
      walkSync(filepath, callback);
    } else if (stats.isFile()) {
      callback(filepath);
    }
  });
};

const isEntryPoint = (relPath: string) => {
  const base = path.parse(relPath).base;
  if (relPath.startsWith("_generated" + path.sep)) {
    return false;
  } else if (base.startsWith(".")) {
    return false;
  } else if (base === "README.md") {
    return false;
  } else if (base === "_generated.ts") {
    return false;
  } else if (base === "schema.ts") {
    return false;
  } else if (base.includes(".test.")) {
    return false;
  } else if (base === "tsconfig.json") {
    return false;
  } else if (relPath.endsWith(".config.js")) {
    return false;
  } else if (relPath.includes(" ")) {
    return false;
  } else if (base.endsWith(".d.ts")) {
    return false;
  } else {
    return true;
  }
};

const shouldTransform = (filePath: string, functionsDir: string) => {
  if (!fs.statSync(filePath).isFile()) {
    return false;
  }
  const base = path.parse(filePath).base;
  const relPath = path.relative(functionsDir, filePath);
  if (relPath.startsWith("_generated" + path.sep)) {
    return false;
  } else if (relPath === "schema.ts") {
    return false;
  } else if (base.startsWith(".")) {
    return false;
  } else if (base === "README.md") {
    return false;
  } else if (base === "tsconfig.json") {
    return false;
  } else if (filePath.endsWith(".config.js")) {
    return false;
  } else {
    return true;
  }
};

const getReactFiles = (project: string, functionsDir: string) => {
  const files = execSync("git grep -l '/_generated/react'", {
    cwd: project,
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .map((f) => path.join(project, f))
    .filter((f) => shouldTransform(f, functionsDir));

  return files;
};

const getConvexFiles = (project: string, functionsDir: string) => {
  const files = execSync("git grep -l '/_generated/server'", {
    cwd: project,
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .map((f) => path.join(project, f))
    .filter((f) => shouldTransform(f, functionsDir));
  return files;
};

// Best effort to find files with a string referencing a convex function
const getAllFiles = (
  project: string,
  functionsDir: string,
  functionPrefixes: string[]
) => {
  const functionPrefixRegexParts: string[] = [];
  // search for both `"listMessages` and `'listMessages`
  functionPrefixes.forEach((p) => {
    functionPrefixRegexParts.push(`"${p}`);
    functionPrefixRegexParts.push(`'${p}`);
  });
  const regex = functionPrefixRegexParts.join("|");
  console.log(regex);
  const files = execSync(`xargs git grep -lE`, {
    cwd: project,
    input: "regex",
    encoding: "utf-8",
  })
    .split("\n")
    .map((f) => path.join(project, f))
    .filter((f) => shouldTransform(f, functionsDir));
  console.log(files);
  return files;
};

const ensureConvexProject = async (project: string) => {
  const packageJsonPath = path.join(project, "package.json");
  const packageJson = fs.readFileSync(packageJsonPath, { encoding: "utf-8" });
  const packageJsonContents = JSON.parse(packageJson);
  if (packageJsonContents["dependencies"]["convex"] === undefined) {
    throw new Error("Convex not found in project dependencies");
  }
};

const getFunctionPrefixes = async (functionsDir: string) => {
  const functionPrefixes: string[] = [];
  walkSync(functionsDir.toString(), (f) => {
    const relPath = path.relative(functionsDir, f);
    if (isEntryPoint(relPath)) {
      const parsedPath = path.parse(relPath);
      // Trim extenstion
      functionPrefixes.push(path.join(parsedPath.dir, parsedPath.name));
    }
  });
  console.log(functionPrefixes);
  return functionPrefixes;
};

const main = async ({ project }: { project: string | undefined }) => {
  if (project === undefined) {
    throw Error("No project specified");
  }
  ensureConvexProject(project);

  const functionsDirName = getFunctionsDirName(project);
  const functionsDir = path.join(project, functionsDirName);

  const functionPrefixes = await getFunctionPrefixes(functionsDir);

  const reactFiles = getReactFiles(project, functionsDir);
  console.log(reactFiles);

  const transformPath = path.resolve("transform.ts");
  await runJSCodeshift(transformPath, reactFiles, {
    kind: "react",
    functionPrefixes,
  });

  const convexFiles = getConvexFiles(project, functionsDir);
  console.log(convexFiles);
  await runJSCodeshift(transformPath, convexFiles, {
    kind: "convex",
    functionPrefixes,
  });

  const otherFiles = getAllFiles(
    project,
    functionsDir,
    functionPrefixes
  ).filter((f) => !reactFiles.includes(f) && !convexFiles.includes(f));
  console.log(otherFiles);
  await runJSCodeshift(transformPath, otherFiles, {
    functionPrefixes,
  });
};

// find package.json with convex in it
// identify functions directory
// get file tree in functions directory
// find imports for _generated/react
// replace with convex/react
// find string literals that match file paths from functions directory

// add import for api from _generated/react
// default to relative imports, but perhaps prompt for a different import style?
// replace with api dot syntax
// remove unused imports

const {
  values: { project },
} = parseArgs({
  options: {
    project: {
      type: "string",
      short: "p",
    },
  },
});
main({ project: project });
