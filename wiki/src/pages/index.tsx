// The landing page: one screen that says what Tokamak is and where to read
// next. A server component, prerendered to static HTML with no page script.
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { getPressContext, type WakuRouteConfig } from "fumapress";
import { Link } from "fumapress/client";
import type { app } from "../../press.config";

export function getConfig() {
  return {
    data: {
      title: "Tokamak",
      description: "A personal AI harness. Threads plus one input; everything else is a plugin.",
    },
  } satisfies WakuRouteConfig;
}

const pillars = [
  {
    title: "Rust kernel, JS userland",
    body: "A Rust server owns storage, scheduling and transport. TypeScript plugins run on the server. A Solid web client runs in Tauri.",
  },
  {
    title: "Plugins all the way down",
    body: "Static manifests, typed exports and slots. The app's own features take the same path as anyone's plugin.",
  },
  {
    title: "One server, thin desktop",
    body: "One tokamak binary holds the plugins and the data, on embedded SurrealDB. The desktop just connects.",
  },
];

export default async function Home() {
  const { nav, links, githubUrl, searchToggle } = await getPressContext<typeof app>().getLayoutProps({
    lang: undefined,
  });

  return (
    <HomeLayout
      nav={nav}
      links={links}
      githubUrl={githubUrl}
      searchToggle={searchToggle}
      themeSwitch={{ enabled: false }}
    >
      <main className="tk-landing relative flex flex-1 flex-col justify-center overflow-hidden">
        <div className="relative mx-auto w-full max-w-5xl px-6 py-16 md:py-24">
          <p className="tk-mono mb-6 text-xs tracking-[0.2em] text-fd-muted-foreground uppercase">
            <span className="tk-dot" aria-hidden="true" /> Tokamak · personal AI harness
          </p>
          <h1 className="max-w-3xl text-4xl leading-[1.05] font-semibold tracking-tight text-balance md:text-6xl">
            Threads plus one input.
            <br />
            <span className="text-fd-muted-foreground">Everything else is a plugin.</span>
          </h1>
          <p className="mt-6 max-w-xl text-base text-fd-muted-foreground md:text-lg">
            Tokamak is a personal AI harness: a small native core, and a TypeScript plugin system for
            everything you build on it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Getting started
            </Link>
            <Link
              href="/docs/api"
              className="tk-mono rounded-md border px-4 py-2 text-sm transition-colors hover:border-fd-primary hover:text-fd-primary"
            >
              Plugin API →
            </Link>
          </div>

          <ul className="mt-16 grid border-t md:grid-cols-3">
            {pillars.map((pillar, index) => (
              <li
                key={pillar.title}
                className="border-b py-6 md:border-b-0 md:px-6 md:first:pl-0 md:[&+li]:border-l"
              >
                <p className="tk-mono text-xs text-fd-primary">{String(index + 1).padStart(2, "0")}</p>
                <h2 className="mt-2 text-sm font-semibold">{pillar.title}</h2>
                <p className="mt-2 text-sm text-fd-muted-foreground">{pillar.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </HomeLayout>
  );
}
