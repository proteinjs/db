import { OAuth2Client } from 'google-auth-library';

/**
 * The conventional env var for an env-delivered GCP access token — `gcloud`'s own
 * `CLOUDSDK_AUTH_ACCESS_TOKEN` override, so a control plane that mints a short-lived,
 * scope-limited token and delivers it over the env channel serves `gcloud`/REST consumers and
 * this driver with the SAME single name. One name, one path; never per-deployment config.
 */
export const SPANNER_ENV_TOKEN_VAR = 'CLOUDSDK_AUTH_ACCESS_TOKEN';

/**
 * How long a minted token is served before the client re-invokes the mint (re-reads the env /
 * re-invokes the refresh hook). google-auth-library refreshes eagerly 5 minutes before
 * `expiry_date` (DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS), so this 10-minute stamp re-reads the
 * env roughly every 5 minutes: an in-place env rotation is picked up within that window with no
 * restart, and the re-read itself is a process-local env access — free.
 */
const TOKEN_REREAD_EXPIRY_MS = 10 * 60_000;

/**
 * Mints the replacement access token when the current one expires or is rejected. Replaces the
 * default mint (re-reading `CLOUDSDK_AUTH_ACCESS_TOKEN`) for runtimes that can mint fresh
 * tokens in-run instead of rotating the env + restarting. Returning nothing is a loud
 * `SpannerEnvTokenAuthError` — never a fallback to application-default credentials.
 */
export type SpannerEnvTokenRefreshHook = () => string | undefined | Promise<string | undefined>;

/**
 * Env-token auth for the Spanner client: authenticates every RPC with the bearer token
 * delivered in `CLOUDSDK_AUTH_ACCESS_TOKEN` instead of application-default credentials.
 *
 * Mechanism (the vendor's sanctioned auth override, @google-cloud/spanner 7.x): the
 * `authClient` option rides `SpannerOptions` into `new GoogleAuth(options)` verbatim
 * (google-auth-library caches it as `cachedCredential`), and google-gax turns that client into
 * per-RPC call credentials (`grpc.credentials.createFromGoogleCredential` →
 * `getRequestHeaders()` per call). The client here is a vendor `OAuth2Client` whose
 * `refreshHandler` is the mint: google-auth-library invokes it on first use and whenever the
 * current token passes its reread expiry, which is exactly the env re-read / refresh-hook
 * cadence.
 *
 * The no-fallback law: env-token auth is selected at client construction because the env var
 * was present; from then on a missing or dead token is a loud typed failure naming the rotation
 * path — the driver NEVER falls back to application-default credentials mid-run (a silent
 * identity switch would hide that the control plane's rotation is due, and change what the
 * process can reach).
 */
export class SpannerEnvTokenAuth {
  /** The auth override handed to the Spanner client as `SpannerOptions.authClient`. */
  readonly authClient: OAuth2Client;

  constructor(private refreshHook?: SpannerEnvTokenRefreshHook) {
    this.authClient = new OAuth2Client();
    this.authClient.refreshHandler = async () => ({
      access_token: await this.mintToken(),
      expiry_date: Date.now() + TOKEN_REREAD_EXPIRY_MS,
    });
  }

  /** Whether env-token auth applies to this process: the conventional env var carries a token. */
  static envTokenPresent(): boolean {
    return !!process.env[SPANNER_ENV_TOKEN_VAR];
  }

  /**
   * Drop the cached token so the next RPC re-mints — re-reads the env var / re-invokes the
   * refresh hook. Called by the driver when Spanner rejects the current token (UNAUTHENTICATED).
   */
  invalidate(): void {
    this.authClient.setCredentials({});
  }

  private async mintToken(): Promise<string> {
    const token = this.refreshHook ? await this.refreshHook() : process.env[SPANNER_ENV_TOKEN_VAR];
    if (!token) {
      throw new SpannerEnvTokenAuthError(
        `No Spanner access token available: ${
          this.refreshHook
            ? 'the configured SpannerConfig.envTokenRefreshHook returned nothing'
            : `${SPANNER_ENV_TOKEN_VAR} is no longer set`
        }. Env-token auth was selected because ${SPANNER_ENV_TOKEN_VAR} was present at client construction, and the ` +
          `driver never falls back to application-default credentials mid-run. Rotate the token: re-configure the ` +
          `runtime env and restart, or provide SpannerConfig.envTokenRefreshHook to mint in-run.`
      );
    }
    return token;
  }
}

/**
 * A dead or missing env-delivered token while env-token auth is active. Always loud, always
 * names the rotation path (re-configure + restart, or `SpannerConfig.envTokenRefreshHook`);
 * the original vendor error, when there is one, rides along as `cause`.
 */
export class SpannerEnvTokenAuthError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SpannerEnvTokenAuthError';
    // target es5: re-point the prototype so `instanceof SpannerEnvTokenAuthError` holds
    Object.setPrototypeOf(this, SpannerEnvTokenAuthError.prototype);
  }
}
