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

const gitGrep = (project: string, functionsDir: string, regex: string) => {
  let output = "";
  try {
    output = execSync("xargs git grep -lE", {
      cwd: project,
      encoding: "utf-8",
      input: regex,
    });
  } catch (e: any) {
    // This indicates there are no files
    if (e.status === 1) {
      return [];
    }
  }

  const files = output
    .trim()
    .split("\n")
    .map((f) => path.join(project, f))
    .filter((f) => shouldTransform(f, functionsDir));

  return files;
};

const getReactFiles = (project: string, functionsDir: string) => {
  return gitGrep(project, functionsDir, "'/_generated/react'");
};

const getConvexFiles = (project: string, functionsDir: string) => {
  return gitGrep(project, functionsDir, "'/_generated/server'");
};

// Best effort to find files with a string referencing a convex function
const getAllFiles = (
  project: string,
  functionsDir: string,
  functionPrefixes: string[]
) => {
  // search for `"listMessages|"sendMessage`
  const doubleQuoteRegex = functionPrefixes.map((f) => `"${f}`).join("|");

  const doubleQuoteFiles = gitGrep(
    project,
    functionsDir,
    `'${doubleQuoteRegex}'`
  );

  // search for `'listMessages|'sendMessage`
  const singleQuoteRegex = functionPrefixes.map((f) => `"${f}`).join("|");

  const singleQuoteFiles = gitGrep(
    project,
    functionsDir,
    `'${singleQuoteRegex}'`
  );
  return [...new Set([...singleQuoteFiles, ...doubleQuoteFiles])];
};

const ensureConvexProject = async (project: string) => {
  const packageJsonPath = path.join(project, "package.json");
  const packageJson = fs.readFileSync(packageJsonPath, { encoding: "utf-8" });
  const packageJsonContents = JSON.parse(packageJson);
  if (packageJsonContents["dependencies"]["convex"] === undefined) {
    console.error(`Not a Convex project: ${project}`);
    process.exit(1);
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
  return functionPrefixes;
};

const main = async ({ project }: { project: string | undefined }) => {
  console.info("Checking project for Convex dependency...");

  if (project === undefined) {
    throw Error("No project specified");
  }
  ensureConvexProject(project);

  console.info("Determining Convex functions directory...");
  const functionsDirName = getFunctionsDirName(project);
  const functionsDir = path.join(project, functionsDirName);

  console.info(`Found directory ${functionsDirName}`);

  const functionPrefixes = await getFunctionPrefixes(functionsDir);

  console.info("Searching for React files...");
  const reactFiles = getReactFiles(project, functionsDir);
  console.info(`# files: ${reactFiles.length}`);
  console.debug(reactFiles);

  console.info("Transforming React files...");
  const transformPath = path.resolve("transform.ts");
  await runJSCodeshift(transformPath, reactFiles, {
    kind: "react",
    functionPrefixes,
  });

  console.info("Searching for Convex function files...");
  const convexFiles = getConvexFiles(project, functionsDir);
  console.info(`# files: ${convexFiles.length}`);
  console.debug(convexFiles);
  console.info("Transforming Convex function files...");
  await runJSCodeshift(transformPath, convexFiles, {
    kind: "server",
    functionPrefixes,
  });

  console.info("Searching for other files containing function names...");
  const otherFiles = getAllFiles(
    project,
    functionsDir,
    functionPrefixes
  ).filter((f) => !reactFiles.includes(f) && !convexFiles.includes(f));
  console.info(`# files: ${otherFiles.length}`);
  console.debug(otherFiles);

  console.info("Transforming remaining files...");
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
