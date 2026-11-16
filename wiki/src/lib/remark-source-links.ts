import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { contentSources, pageUrl } from "../../content-sources.mjs";
import { generatedDocs, repoRoot } from "../../scripts/sync-content.mjs";

interface Node {
  type: string;
  url?: string;
  children?: Node[];
}

// Rewrite actual Markdown links/definitions, never code examples. Resolve them
// beside the original package file, then route included docs into the site.
export function remarkSourceLinks() {
  return (tree: Node, file: { path?: string }) => {
    if (!file.path) return;
    const page = relative(generatedDocs, file.path).replaceAll("\\", "/");
    const entry = contentSources.find((entry) => entry.page === page);
    if (!entry) return;
    const walk = (node: Node) => {
      if (
        (node.type === "link" || node.type === "definition" || node.type === "image") &&
        node.url &&
        !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(node.url)
      ) {
        const [, pathname = "", suffix = ""] = node.url.match(/^([^?#]*)(.*)$/)!;
        const target = pathname
          ? resolve(repoRoot, dirname(entry.source), decodeURI(pathname))
          : resolve(repoRoot, entry.source);
        const linked = contentSources.find((source) => resolve(repoRoot, source.source) === target);
        node.url =
          linked && existsSync(target)
            ? pageUrl(linked.page) + suffix
            : (node.type === "image"
                ? "https://raw.githubusercontent.com/pixelscortex/tokamak/dev/"
                : "https://github.com/pixelscortex/tokamak/blob/dev/") +
              relative(repoRoot, target).replaceAll("\\", "/") +
              suffix;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
