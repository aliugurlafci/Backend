/**
 * Re-export. The definition lives in `packages/contracts`, shared with the other
 * application.
 *
 * The copy that used to sit in the web app was missing `positionId` and
 * `grants`, which is why its permission engine could not tell an explicit grant
 * set from a role set — a stale type quietly narrowing what the code below it
 * could even express.
 */
export * from "@aula/contracts/context/types";
