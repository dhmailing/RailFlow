import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { readExecutionProfile } from "./scripts/execution-profile.mjs";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";

const localBindingConfig = {
  main: "vinext/server/fetch-handler",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Use Miniflare's local Request.cf placeholder unless fetching is requested.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      ...(managedLinux ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] } : {}),
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    ssr: {
      // playwright-core ships a self-contained CJS bundle with internal
      // lazy `require()`s (e.g. chromium-bidi) that rolldown cannot resolve
      // statically. It is a devDependency used only by
      // lib/automation/providers/mock-browser-provider.ts, gated to never
      // run outside local/dev Node processes (see
      // docs/V0.7-AUTOMATION-BOUNDARY.md) -- excluding it from bundling here
      // only fixes the build; it does not make Playwright usable inside the
      // Cloudflare Workers runtime this build targets.
      // `pg` 도 같은 이유로 뺀다. Node 전용 드라이버이며 이 빌드가 겨냥하는
      // Workers 런타임에서는 동작하지 않는다. lib/autobook/postgres/client.ts
      // 가 **동적 import** 로만 불러오고, 기본 fail-closed 경로에서는 그 줄에
      // 도달하지도 않는다. external 지정은 번들러가 정적 분석으로 이 경로를
      // 끌어와 빌드를 깨뜨리지 못하게 하는 보강이다 -- 이것이 Workers 안에서
      // PostgreSQL 을 쓸 수 있게 만들어 주지는 않는다(Worker 는 별도 Node
      // 프로세스에서 돈다, docs/V0.10-POSTGRES-WORKER-READINESS.md).
      external: ["playwright", "playwright-core", "pg", "pg-native"],
    },
    build: {
      rolldownOptions: {
        external: ["playwright", "playwright-core", "pg", "pg-native"],
      },
    },
    plugins: [
      vinext(),
      sites({ mockAuth: !managedLinux }),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
