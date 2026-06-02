/**
 * Claim verifiability policy — single source of truth for HOW each claim type
 * should be audited.
 *
 * The supply team must independently re-verify content, but not every claim is
 * verifiable the same way:
 *
 *  - EXTERNALLY VERIFIABLE: facts that a third-party source (PMG pages / web)
 *    can confirm or contradict — distances, offers, policies, FAQs. These go to
 *    {@link PmgFactChecker}.
 *
 *  - OPERATOR-ASSERTED: facilities the operator provides (gym, pool, Wi-Fi). A
 *    generic PMG page rarely lists them per-property, so fact-checking them just
 *    produces `missing_evidence` noise. We assume them correct UNLESS an internal
 *    contradiction proves otherwise (handled by {@link ListingConsistencyChecker}).
 *
 *  - DYNAMIC/QUANTITATIVE: values that change frequently (rent, deposit, room
 *    size). External evidence is usually stale, so we do not hard-flag them on
 *    weak evidence; they are still checked for internal consistency + plausibility.
 *
 * This mirrors the editorial audit standard: only flag a claim when we have a
 * verifiable conflict or an internal inconsistency, never merely because it is
 * unverified.
 */
import { TextClaimType } from '../../../../shared/types';

/** Claim types worth checking against fetched PMG page text (see PmgFactChecker). */
const EXTERNALLY_VERIFIABLE: ReadonlySet<TextClaimType> = new Set<TextClaimType>([
  'distance',
  'offer',
  'policy_term',
  'cancellation_term',
  'house_rule',
  'faq',
  'other',
]);

/** Operator-provided facilities — assumed correct unless internally contradicted. */
const OPERATOR_ASSERTED: ReadonlySet<TextClaimType> = new Set<TextClaimType>(['amenity']);

/**
 * True when an external source could meaningfully confirm/contradict the claim.
 * Only these are routed to fact-checking.
 */
export function isExternallyVerifiable(claimType: TextClaimType): boolean {
  return EXTERNALLY_VERIFIABLE.has(claimType);
}

/** True for operator-provided facilities that we assume correct by default. */
export function isOperatorAsserted(claimType: TextClaimType): boolean {
  return OPERATOR_ASSERTED.has(claimType);
}
