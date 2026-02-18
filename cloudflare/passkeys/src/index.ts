interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  RP_ID: string;
  APPLE_TEAM_ID: string;
  IOS_BUNDLE_ID: string;
  ANDROID_PACKAGE_NAME: string;
  ANDROID_SHA256_CERT_FINGERPRINTS: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}

function requiredEnv(env: Env, key: keyof Omit<Env, "ASSETS">): string | null {
  const value = env[key];
  if (!value || !value.trim()) return null;
  return value.trim();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/apple-app-site-association") {
      const appleTeamId = requiredEnv(env, "APPLE_TEAM_ID");
      const iosBundleId = requiredEnv(env, "IOS_BUNDLE_ID");

      if (!appleTeamId || !iosBundleId) {
        return jsonResponse(
          {
            error:
              "Missing APPLE_TEAM_ID or IOS_BUNDLE_ID. Set them in Wrangler vars before using passkeys.",
          },
          500,
        );
      }

      return jsonResponse({
        applinks: {},
        webcredentials: {
          apps: [`${appleTeamId}.${iosBundleId}`],
        },
        appclips: {},
      });
    }

    if (url.pathname === "/.well-known/assetlinks.json") {
      const packageName = requiredEnv(env, "ANDROID_PACKAGE_NAME");
      const fingerprints = requiredEnv(env, "ANDROID_SHA256_CERT_FINGERPRINTS");

      if (!packageName || !fingerprints) {
        return jsonResponse(
          {
            error:
              "Missing ANDROID_PACKAGE_NAME or ANDROID_SHA256_CERT_FINGERPRINTS. Set them in Wrangler vars before using passkeys.",
          },
          500,
        );
      }

      return jsonResponse([
        {
          relation: ["delegate_permission/common.get_login_creds"],
          target: {
            namespace: "android_app",
            package_name: packageName,
            sha256_cert_fingerprints: fingerprints
              .split(",")
              .map((fingerprint) => fingerprint.trim())
              .filter(Boolean),
          },
        },
      ]);
    }

    return env.ASSETS.fetch(request);
  },
};
