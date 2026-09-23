import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const sourceRoot = resolve("src");
const featuresRoot = resolve(sourceRoot, "features");
const failures = [];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(?:ts|tsx)$/.test(path) ? [path] : [];
  });
}

function featureFor(path) {
  const featurePath = relative(featuresRoot, path);
  if (featurePath.startsWith(`..${sep}`) || featurePath === "..") {
    return undefined;
  }
  return featurePath.split(sep)[0];
}

function importTargets(source) {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

for (const path of sourceFiles(sourceRoot)) {
  const source = readFileSync(path, "utf8");
  const ownerFeature = featureFor(path);
  const relativePath = relative(sourceRoot, path);

  for (const target of importTargets(source)) {
    if (!target.startsWith(".")) {
      continue;
    }
    const resolvedTarget = resolve(dirname(path), target);
    const targetFeature = featureFor(resolvedTarget);
    if (ownerFeature && targetFeature && ownerFeature !== targetFeature) {
      failures.push(
        `${relativePath} imports feature "${targetFeature}" directly; communicate through the app shell or a shared contract`,
      );
    }
    if (!ownerFeature && targetFeature) {
      const targetWithinFeatures = relative(featuresRoot, resolvedTarget).split(
        sep,
      );
      if (targetWithinFeatures.length > 1) {
        failures.push(
          `${relativePath} deep-imports feature "${targetFeature}"; use its public index`,
        );
      }
    }
    if (
      ownerFeature &&
      relative(sourceRoot, resolvedTarget).split(sep)[0] === "app"
    ) {
      failures.push(
        `${relativePath} imports the app layer; feature dependencies must point inward`,
      );
    }
    if (
      relativePath.startsWith(`components${sep}ui${sep}`) &&
      (targetFeature ||
        relative(sourceRoot, resolvedTarget).split(sep)[0] === "app")
    ) {
      failures.push(
        `${relativePath} imports an app/feature module; shared UI must stay dependency-free`,
      );
    }
  }

  if (
    /[/\\]features[/\\][^/\\]+[/\\][^/\\]+-feature\.tsx$/.test(path) &&
    !/[/\\]use-[^/\\]+-feature\.tsx$/.test(path)
  ) {
    const lines = source.split("\n").length;
    if (lines > 350) {
      failures.push(
        `${relativePath} has ${lines} lines; split private subcomponents before the feature facade exceeds 350`,
      );
    }
  }

  if (ownerFeature) {
    const lines = source.split("\n").length;
    if (lines > 1000) {
      failures.push(
        `${relativePath} has ${lines} lines; split the feature module before it exceeds 1000`,
      );
    }
  }
}

const appPath = resolve(sourceRoot, "App.tsx");
if (statSync(appPath).isFile()) {
  const appSource = readFileSync(appPath, "utf8");
  const appLines = appSource.split("\n").length;
  if (appLines > 1200) {
    failures.push(
      `App.tsx has ${appLines} lines; the shell budget allows at most 1200`,
    );
  }
  for (const match of appSource.matchAll(
    /\bfrom\s+["']\.\/features\/([^/"']+)\/([^"']+)["']/g,
  )) {
    failures.push(
      `App.tsx deep-imports feature "${match[1]}/${match[2]}"; use the feature public index`,
    );
  }
}

const styleOwnership = {
  "10-issues.css": [
    "fdy-chat-",
    "fdy-runs-",
    "fdy-asset-",
    "fdy-workspace-manager",
    "fdy-local-daemon",
  ],
  "20-chat.css": [
    "fdy-issue-",
    "fdy-runs-",
    "fdy-asset-",
    "fdy-skill-registry",
    "fdy-workspace-manager",
    "fdy-local-daemon",
  ],
  "30-runs.css": [
    "fdy-chat-",
    "fdy-issue-",
    "fdy-asset-",
    "fdy-skill-registry",
    "fdy-workspace-manager",
    "fdy-local-daemon",
  ],
};

for (const [name, foreignPrefixes] of Object.entries(styleOwnership)) {
  const source = readFileSync(resolve(sourceRoot, "styles", name), "utf8");
  for (const prefix of foreignPrefixes) {
    if (source.includes(`.${prefix}`)) {
      failures.push(
        `styles/${name} contains foreign selector ".${prefix}*"; move it to the owning feature style`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Feature architecture audit failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Feature architecture audit passed.");
