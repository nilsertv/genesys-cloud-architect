// Tiny in-process singleton holding the current PKCE user token, if any.
// Lets a fresh login_user call take effect immediately for
// deploy_flow/update_flow/read_flow's NEXT call, without restarting the
// server — those tools receive `getUserToken` (this function reference, not
// a snapshotted value) so they always read the latest token.

import type { UserToken } from "./user-token-store.ts";

let currentUserToken: UserToken | undefined;

export function getUserToken(): UserToken | undefined {
    return currentUserToken;
}

export function setUserToken(token: UserToken | undefined): void {
    currentUserToken = token;
}
