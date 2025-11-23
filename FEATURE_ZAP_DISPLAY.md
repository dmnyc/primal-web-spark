# Zap Payment Display Feature Documentation

This document describes the implementation of rich zap payment display in the Spark wallet, showing sender/recipient information with NIP-05 handles and usernames.

## Overview

The zap payment display feature enriches Lightning payment history by:
- Detecting which payments are Nostr zaps (NIP-57)
- Fetching and displaying user profiles for zap senders/recipients
- Showing human-readable names (NIP-05, usernames) instead of hex pubkeys
- Providing clickable links to profiles and zapped notes

## Key Components

### 1. Payment Data Structure

**File**: `src/lib/breezWalletService.ts`

Extended `BreezPaymentInfo` type with zap-specific fields:

```typescript
export type BreezPaymentInfo = {
  // ... standard payment fields

  // Zap-specific fields (NIP-57)
  isZap?: boolean;                  // True if this payment is a Nostr zap
  zapSenderPubkey?: string;         // Sender's nostr pubkey (hex)
  zapRecipientPubkey?: string;      // Recipient's nostr pubkey (hex)
  zapComment?: string;              // Zap comment/message
  zapEventId?: string;              // Event ID if zapping a note
};
```

### 2. Zap Data Storage

**File**: `src/lib/zap.ts`

#### Payment Hash Extraction

Uses `light-bolt11-decoder` library to decode BOLT11 invoices:

```typescript
import { decode as decodeBolt11 } from 'light-bolt11-decoder';

// Decode invoice to get payment hash
const decoded = decodeBolt11(invoice);
const paymentHash = decoded?.sections?.find((s: any) => s.name === 'payment_hash')?.value;
```

**Important**: The custom `parseBolt11` function in `src/utils.ts` only extracts amount, NOT payment hash. Must use `light-bolt11-decoder`.

#### LocalStorage Persistence

```typescript
// Save zap request data keyed by payment hash
const zapData = { zapRequest, recipientPubkey };
saveZapData(paymentHash, zapData);
```

Storage structure:
```javascript
{
  "primal_spark_zap_data": {
    "<payment_hash>": {
      "zapRequest": { /* NIP-57 kind 9734 event */ },
      "recipientPubkey": "<hex_pubkey>",
      "timestamp": 1234567890
    }
  }
}
```

### 3. Profile Fetching

**File**: `src/components/SparkPaymentsList/SparkPaymentsList.tsx`

#### Profile Store

```typescript
const [zapProfiles, setZapProfiles] = createStore<Record<string, PrimalUser>>({});
```

#### Collection Logic

```typescript
createEffect(() => {
  const zapPayments = props.payments.filter(p => p.isZap);
  const pubkeysToFetch = new Set<string>();

  zapPayments.forEach(payment => {
    // For outgoing zaps, fetch recipient profiles
    if (payment.paymentType === 'send' && payment.zapRecipientPubkey) {
      pubkeysToFetch.add(payment.zapRecipientPubkey);
    }
    // For incoming zaps, fetch sender profiles
    if (payment.paymentType === 'receive' && payment.zapSenderPubkey) {
      pubkeysToFetch.add(payment.zapSenderPubkey);
    }
  });

  const pubkeys = Array.from(pubkeysToFetch);
  // ... fetch profiles
});
```

#### Subscription Pattern

**Critical**: Must use object with `onEvent` and `onEose` callbacks:

```typescript
const unsub = subsTo(subId, {
  onEvent: (_, content) => {
    if (content?.kind === 0) {
      const user = convertToUser(content);
      if (user) {
        setZapProfiles(user.pubkey, user);
      }
    }
  },
  onEose: () => {
    unsub();
  }
});

getUserProfiles(pubkeys, subId);
```

**Wrong approach** (callback function):
```typescript
// ❌ This won't work - subsTo expects an object
const unsub = subsTo(subId, (type, _, content) => { ... });
```

### 4. Display Name Resolution

Priority order for displaying user identity:

```typescript
const getZapUserDisplay = (pubkey: string) => {
  const profile = zapProfiles[pubkey];

  // 1. Try NIP-05 first (e.g., "jack@primal.net")
  if (profile?.nip05) {
    const nip05Display = nip05Verification(profile);
    if (nip05Display) return nip05Display;
  }

  // 2. Fall back to display name (e.g., "Jack")
  if (profile) {
    const name = userName(profile);
    if (name) return name;
  }

  // 3. Fall back to truncated npub (e.g., "npub1abc...xyz")
  return truncateId(hexToNpub(pubkey));
};
```

### 5. UI Layout

#### Outgoing Zaps
```
-21 sats + 3 sats fee                     11/22/2025, 8:37:40 PM
⚡ Zap  You → jack@primal.net              completed
💬 Great post!
```

#### Incoming Zaps
```
+100 sats                                  11/22/2025, 9:15:23 PM
⚡ Zap  alice@nostr.com → You              completed
💬 Thanks for the content!
```

#### UI Structure
- **First line**: Amount, timestamp
- **Second line**: Zap badge (clickable to note), sender/recipient, status
- **Third line** (optional): Zap comment

## Implementation Checklist

For similar implementations (e.g., other payment types, wallet integrations):

### Backend/Data Layer
- [ ] Identify unique identifier for linking payment to metadata (payment hash, etc.)
- [ ] Choose decoder library for invoice format
  - BOLT11: `light-bolt11-decoder`
  - Other formats: research appropriate library
- [ ] Extract identifier from payment/invoice
- [ ] Store metadata in localStorage with cleanup strategy
- [ ] Retrieve metadata when displaying payments

### Profile Fetching
- [ ] Create SolidJS store for profiles: `createStore<Record<string, PrimalUser>>({})`
- [ ] Use `createEffect` to collect pubkeys from visible payments
- [ ] Deduplicate pubkeys: `new Set<string>()`
- [ ] Subscribe to profile events with correct callback format:
  ```typescript
  subsTo(subId, {
    onEvent: (_, content) => { /* handle kind 0 */ },
    onEose: () => { /* cleanup */ }
  })
  ```
- [ ] Call `getUserProfiles(pubkeys, subId)` from `src/lib/profile.ts`
- [ ] Convert events with `convertToUser()` from `src/stores/profile.ts`
- [ ] Add cleanup with `onCleanup()`

### Display Logic
- [ ] Create display name helper with priority:
  1. NIP-05 (`nip05Verification()`)
  2. Display name (`userName()`)
  3. Truncated identifier (`truncateId()`)
- [ ] Convert hex to readable format (`hexToNpub()`, `hexToNote()`)
- [ ] Create profile links (`/p/${npub}`)
- [ ] Create event links (`/e/${note}`)

### UI Components
- [ ] Conditional rendering for incoming vs outgoing
- [ ] Spacing/layout for additional info line
- [ ] Status badges
- [ ] Clickable links with hover states
- [ ] Copy buttons for expanded details

### Styling
- [ ] Badge styles (`.zapBadge`, `.zapBadgeLink`)
- [ ] Info line layout (`.zapInfoLine`, `.zapInfoLeft`, `.zapInfoRight`)
- [ ] Link styles (`.zapRecipientLink`, `.zapNoteLink`)
- [ ] Spacing adjustments (`margin-bottom` for line spacing)

## Common Pitfalls

### 1. Using Wrong BOLT11 Decoder
**Problem**: `parseBolt11()` from `src/utils.ts` only extracts amount
**Solution**: Use `light-bolt11-decoder` package

### 2. Wrong subsTo Callback Format
**Problem**: Passing function instead of object
**Solution**: Use `{ onEvent, onEose }` object format

### 3. Profile Not Updating in UI
**Problem**: Store not triggering reactivity
**Solution**: Ensure using `setZapProfiles(pubkey, user)` not `zapProfiles[pubkey] = user`

### 4. Duplicate Profile Fetches
**Problem**: Fetching same profile multiple times
**Solution**: Use `Set` to deduplicate pubkeys before fetching

### 5. Memory Leaks
**Problem**: Subscriptions not cleaned up
**Solution**: Always call `unsub()` in `onEose` and `onCleanup()`

## Related Files

### Core Implementation
- `src/lib/zap.ts` - Zap data storage and retrieval
- `src/lib/breezWalletService.ts` - Payment type definitions and detection
- `src/components/SparkPaymentsList/SparkPaymentsList.tsx` - UI component
- `src/components/SparkPaymentsList/SparkPaymentsList.module.scss` - Styles

### Dependencies
- `src/lib/profile.ts` - Profile fetching (`getUserProfiles`)
- `src/stores/profile.ts` - Profile conversion (`convertToUser`, `nip05Verification`, `userName`)
- `src/sockets.tsx` - Subscription system (`subsTo`)
- `src/lib/nTools.ts` - Nostr utilities (`nip19`)
- `light-bolt11-decoder` - BOLT11 invoice decoding

### Type Definitions
- `src/types/primal.d.ts` - `PrimalUser` type

## Testing Checklist

- [ ] Outgoing zaps show "You → recipient"
- [ ] Incoming zaps show "sender → You"
- [ ] NIP-05 displays correctly (e.g., "jack@primal.net")
- [ ] Usernames display when no NIP-05
- [ ] Truncated npub shows as fallback
- [ ] Profile links navigate correctly
- [ ] Zapped note links work
- [ ] Zap badge is clickable (when note exists)
- [ ] Status badges show correct state
- [ ] Zap comments display below
- [ ] Expanded details show full data
- [ ] Copy buttons work in details
- [ ] No duplicate profile fetches
- [ ] No memory leaks (subscriptions cleaned up)
- [ ] Works with both Bitcoin and testnet

## Future Enhancements

Potential improvements for future iterations:

1. **Profile Avatars**: Show small profile pictures next to names
2. **Profile Caching**: Cache profiles across sessions to reduce fetches
3. **Optimistic Updates**: Show skeleton/loading state while fetching profiles
4. **Batch Fetching**: Implement windowing for large payment lists
5. **Rich Zap Receipts**: Fetch and display kind 9735 zap receipts from relays
6. **Zap Amount Breakdown**: Show invoice amount vs actual zap amount
7. **Zap Analytics**: Aggregate zap stats (total sent/received, top zappers, etc.)
8. **Profile Hover Cards**: Show profile preview on hover
9. **Inline Zap Reply**: Quick zap back functionality from payment history

### 6. Incoming Zap Receipt Fetching

**File**: `src/lib/spark/fetchZapReceipts.ts`

For incoming zaps, we need to query Nostr relays for zap receipts (kind 9735):

```typescript
import { fetchZapReceiptForInvoice } from './spark/fetchZapReceipts';

// Query relays for zap receipt matching the invoice
const zapReceipt = await fetchZapReceiptForInvoice(
  payment.invoice,
  userPubkey, // Recipient pubkey to filter by
  relayUrls
);
```

**Zap Receipt Structure** (kind 9735):
```javascript
{
  kind: 9735,
  tags: [
    ['bolt11', '<invoice>'],
    ['description', '<zap_request_json>'], // kind 9734 event
    ['p', '<recipient_pubkey>'],
    ['e', '<event_id>'], // Optional, if zapping a note
    ['amount', '<millisats>'],
    ['preimage', '<payment_proof>'] // Optional
  ]
}
```

**Enrichment Process**:
1. Query relays filtering by `kinds: [9735], #p: [userPubkey]`
2. For each event, check if bolt11 tag matches the invoice
3. Parse embedded zap request from description tag
4. Extract sender from zap request pubkey
5. Extract event ID from 'e' tag
6. Extract comment from zap request content
7. Update payment in UI reactively

**Performance Considerations**:
- Enrichment runs in background after initial payment load
- Queries 4 relays in parallel with 5s timeout per relay
- Overall timeout of 10s per payment
- Updates UI reactively as receipts are found

## Version History

- **v1.1** (Nov 2025): Incoming zap receipt fetching
  - Query Nostr relays for kind 9735 zap receipts
  - Match receipts to payments by invoice
  - Background enrichment after payment load
  - Reactive UI updates as receipts are found

- **v1.0** (Nov 2025): Initial implementation
  - Outgoing zap display with recipient info
  - NIP-05 and username resolution
  - Profile fetching and caching
  - Clickable zap badge linking to notes
  - Incoming zap display with sender info
