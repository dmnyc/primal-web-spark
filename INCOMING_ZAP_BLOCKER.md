# Incoming Zap Display - BLOCKED

## Issue
Cannot display sender information for incoming zap payments due to Breez Spark SDK bug.

## Root Cause
**Breez SDK Issue**: https://github.com/breez/spark-sdk/issues/397

When receiving NIP-57 zaps, the Breez Spark SDK does not populate the `description` field in payment details. This field normally contains the zap request (kind 9734 Nostr event) which includes:
- Sender pubkey
- Zapped event ID (if applicable)
- Comment/message
- Other zap metadata

Without this field, we cannot extract sender information from incoming payments.

## Current Status
- ✅ **Outgoing zaps**: Working perfectly - sender info is stored in localStorage
- ❌ **Incoming zaps**: Blocked by SDK bug - no description field available

## Attempted Workarounds
1. **Query Nostr relays for zap receipts** - Too slow, complex, unreliable
2. **Use Primal cache to fetch zap receipts** - Implemented but requires matching invoices

## Code Location
Branch: `feature/zap-npub-payment-history`

Key files:
- `src/contexts/SparkWalletContext.tsx` - `enrichIncomingZaps()` function (Primal cache workaround)
- `src/lib/breezWalletService.ts` - `enrichPaymentWithZapData()` function (parses descriptions)
- `src/components/SparkPaymentsList/SparkPaymentsList.tsx` - UI for displaying zap info

## Next Steps
1. **Wait for Breez to fix SDK** - Monitor issue #397 for updates
2. **Test workaround** - Once SDK is fixed or if workaround needs debugging
3. **Complete feature** - Enable incoming zap sender display

## Recommendation
Stash this branch and revisit when Breez SDK issue #397 is resolved.

## Date
2025-11-22
