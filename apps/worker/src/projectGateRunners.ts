import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CommandGateRunnerV2,
  GateCommandResolution,
  GateResolutionContext,
  GateRunnerV2
} from "./gateRegistry.js";

const SCRIPT_BY_GATE: Readonly<Record<string, string>> = {
  unit_test: "test",
  lint: "lint",
  typecheck: "typecheck"
};

function command(
  executable: string,
  args: readonly string[],
  versionArgs: readonly string[] = ["--version"]
): GateCommandResolution {
  return {
    executable,
    args,
    display: [executable, ...args].join(" "),
    versionArgs
  };
}

function declaredCommand(
  context: GateResolutionContext
): GateCommandResolution | undefined {
  const declared = context.declaredCommands?.[context.gateId];
  if (!declared) return undefined;
  return command(declared.executable, declared.args);
}

export function createNodeGateRunner(): CommandGateRunnerV2 {
  return {
    id: "builtin/node-project-gates",
    version: "2",
    gateIds: ["unit_test", "lint", "typecheck"],
    languages: ["javascript", "typescript"],
    async resolveCommand(context) {
      const declared = declaredCommand(context);
      if (declared) return declared;
      const script = SCRIPT_BY_GATE[context.gateId];
      if (!script || !(await hasNpmScript(join(context.cwd, "package.json"), script))) {
        return undefined;
      }
      return command("npm", ["run", script]);
    }
  };
}

export function createGoGateRunner(): CommandGateRunnerV2 {
  return {
    id: "builtin/go-project-gates",
    version: "2",
    gateIds: ["unit_test", "lint", "typecheck"],
    languages: ["go"],
    resolveCommand(context) {
      const declared = declaredCommand(context);
      if (declared) return declared;
      if (context.gateId === "unit_test") return command("go", ["test", "./..."], ["version"]);
      if (context.gateId === "lint") return command("go", ["vet", "./..."], ["version"]);
      if (context.gateId === "typecheck") {
        return command("go", ["test", "-run=^$", "./..."], ["version"]);
      }
      return undefined;
    }
  };
}

export function createJavaGateRunner(): CommandGateRunnerV2 {
  return {
    id: "builtin/java-project-gates",
    version: "2",
    gateIds: ["unit_test", "lint", "typecheck"],
    languages: ["java", "kotlin"],
    async resolveCommand(context) {
      const declared = declaredCommand(context);
      if (declared) return declared;
      if (await exists(join(context.cwd, "mvnw"))) {
        return context.gateId === "unit_test"
          ? command("./mvnw", ["test"])
          : command("./mvnw", ["verify", "-DskipTests"], ["--version"]);
      }
      if (await exists(join(context.cwd, "pom.xml"))) {
        return context.gateId === "unit_test"
          ? command("mvn", ["test"])
          : command("mvn", ["verify", "-DskipTests"], ["--version"]);
      }
      if (await exists(join(context.cwd, "gradlew"))) {
        return context.gateId === "unit_test"
          ? command("./gradlew", ["test"])
          : command("./gradlew", ["check", "-x", "test"], ["--version"]);
      }
      return undefined;
    }
  };
}

export function createPythonGateRunner(): CommandGateRunnerV2 {
  return {
    id: "builtin/python-project-gates",
    version: "2",
    gateIds: ["unit_test", "lint", "typecheck"],
    languages: ["python"],
    resolveCommand(context) {
      const declared = declaredCommand(context);
      if (declared) return declared;
      if (context.gateId === "unit_test") return command("python", ["-m", "pytest"], ["--version"]);
      if (context.gateId === "lint") return command("python", ["-m", "ruff", "check", "."], ["--version"]);
      if (context.gateId === "typecheck") return command("python", ["-m", "mypy", "."], ["--version"]);
      return undefined;
    }
  };
}

export function createRustGateRunner(): CommandGateRunnerV2 {
  return {
    id: "builtin/rust-project-gates",
    version: "2",
    gateIds: ["unit_test", "lint", "typecheck"],
    languages: ["rust"],
    resolveCommand(context) {
      const declared = declaredCommand(context);
      if (declared) return declared;
      if (context.gateId === "unit_test") return command("cargo", ["test"]);
      if (context.gateId === "lint") return command("cargo", ["clippy", "--", "-D", "warnings"]);
      if (context.gateId === "typecheck") return command("cargo", ["check"]);
      return undefined;
    }
  };
}

async function hasNpmScript(path: string, script: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "scripts" in value &&
      typeof value.scripts === "object" &&
      value.scripts !== null &&
      !Array.isArray(value.scripts) &&
      typeof (value.scripts as Record<string, unknown>)[script] === "string"
    );
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createDefaultProjectGateRunners(): readonly GateRunnerV2[] {
  return [
    createNodeGateRunner(),
    createGoGateRunner(),
    createJavaGateRunner(),
    createPythonGateRunner(),
    createRustGateRunner()
  ];
}
