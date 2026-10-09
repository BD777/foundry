import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type {
  SkillRepository,
  SkillToolDeclaration,
} from "@bd777/foundry-protocol";
import { addSkillRepository } from "../../api";
import { Button } from "../../components/ui/button";
import { i18n } from "../../i18n";

const npmPrefix = "npm:";
const githubPrefix = "https://github.com/";

/** Where a followed repository or npm package can be opened. */
export function repositoryHref(
  url: string,
  source: { label?: string; registry?: string; fetchDeviceId?: string } = {},
): string {
  if (url.startsWith(npmPrefix))
    // A package on a private registry has no page Foundry knows of.
    return source.registry || source.fetchDeviceId
      ? ""
      : `https://www.npmjs.com/package/${url.slice(npmPrefix.length)}`;
  // An ssh remote is opened as its host's web page.
  if (!url.startsWith("https://"))
    return source.label ? `https://${source.label}` : "";
  return url;
}

export interface RecommendedBundle {
  /** The bundle's name in the library. */
  name: string;
  author: string;
  /**
   * The source followed, as the server records it: an npm package ships its
   * CLI and its skills; a git repository ships the skill, whose CLI comes
   * from `tools`.
   */
  url: string;
  subpath: string;
  /** Programs its source does not publish, e.g. a Python CLI on PyPI. */
  tools?: SkillToolDeclaration[];
  /** i18n key of what it is, under skills:library.recommended.items. */
  key: "agentBrowser" | "playwrightCli" | "browserUse";
}

/**
 * Bundles offered with one click, each an official agent skill with the CLI
 * it runs at a matching version. agent-browser and playwright-cli ship both
 * in their npm package. browser-use publishes its skill in its GitHub
 * repository (skills/browser-use, tagged with each release) and its CLI on
 * PyPI under the same version numbers.
 */
export const recommendedBundles: RecommendedBundle[] = [
  {
    name: "agent-browser",
    author: "Vercel",
    url: "npm:agent-browser",
    subpath: "skills",
    key: "agentBrowser",
  },
  {
    name: "playwright-cli",
    author: "Microsoft",
    url: "npm:@playwright/cli",
    subpath: "skills",
    key: "playwrightCli",
  },
  {
    name: "browser-use",
    author: "Browser Use",
    url: "https://github.com/browser-use/browser-use",
    subpath: "skills/browser-use",
    tools: [{ source: "uv", package: "browser-use", command: "browser-use" }],
    key: "browserUse",
  },
];

/** Where a recommended bundle's skill and CLI come from, in one line. */
export function recommendedSource(item: RecommendedBundle): string {
  const skill = item.url.startsWith(npmPrefix)
    ? i18n.t("skills:library.recommended.source", {
        package: item.url.slice(npmPrefix.length),
      })
    : i18n.t("skills:library.recommended.sourceRepository", {
        repository: item.url.startsWith(githubPrefix)
          ? item.url.slice(githubPrefix.length)
          : item.url,
      });
  return [
    skill,
    ...(item.tools ?? []).map((tool) =>
      i18n.t("skills:library.recommended.sourceUv", { package: tool.package }),
    ),
  ].join(" · ");
}

/**
 * Recommended bundles the library does not follow yet, each with Add. Shown
 * to admins, who can follow repositories.
 */
export function RecommendedBundles({
  repositories,
  disabled,
  onChanged,
}: {
  repositories: SkillRepository[];
  /** Another repository action is running. */
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const [adding, setAdding] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const followed = new Set(repositories.map((repo) => repo.url));
  const offered = recommendedBundles.filter((item) => !followed.has(item.url));
  if (offered.length === 0) return null;

  const add = async (item: RecommendedBundle) => {
    setAdding(item.url);
    setErrors((current) => ({ ...current, [item.url]: "" }));
    try {
      await addSkillRepository({
        url: item.url,
        ref: "",
        subpath: item.subpath,
        mode: "bundle",
        name: item.name,
        ...(item.tools ? { tools: item.tools } : {}),
      });
      await onChanged();
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [item.url]: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setAdding("");
    }
  };

  return (
    <section
      aria-labelledby="fdy-skill-recommended-title"
      className="fdy-skill-recommended"
    >
      <div className="fdy-skill-recommended-heading">
        <h3 id="fdy-skill-recommended-title">
          {t("library.recommended.title")}
        </h3>
        <p>{t("library.recommended.description")}</p>
      </div>
      <ul className="fdy-skill-repo-list">
        {offered.map((item) => (
          <li className="fdy-skill-repo-row" key={item.url}>
            <div className="fdy-skill-repo-copy">
              <span className="fdy-skill-bundle-title">
                <a
                  href={repositoryHref(item.url)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {item.name}
                </a>
                <span className="fdy-skill-repo-version">
                  {t("library.recommended.by", { author: item.author })}
                </span>
              </span>
              <p className="fdy-skill-repo-description">
                {t(`library.recommended.items.${item.key}`)}
              </p>
              <small>{recommendedSource(item)}</small>
              {adding === item.url ? (
                <p className="fdy-skill-repo-status" role="status">
                  {item.url.startsWith(npmPrefix)
                    ? t("library.recommended.addingNote")
                    : t("library.repo.reading")}
                </p>
              ) : null}
              {errors[item.url] ? (
                <p className="fdy-skill-error" role="alert">
                  {errors[item.url]}
                </p>
              ) : null}
            </div>
            <div className="fdy-skill-repo-actions">
              <Button
                aria-busy={adding === item.url}
                aria-label={t("library.recommended.addLabel", {
                  name: item.name,
                })}
                disabled={disabled || Boolean(adding)}
                onClick={() => void add(item)}
                size="sm"
                variant="secondary"
              >
                <Plus size={14} />
                {adding === item.url
                  ? t("library.recommended.adding")
                  : t("library.recommended.add")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
