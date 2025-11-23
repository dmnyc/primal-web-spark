# Zap Enrichment Debug Instructions

## Quick Console Filter

To see only relevant logs, paste this in your browser console:

```javascript
// Clear console and set up filter
console.clear();

// Store original console.log
const originalLog = console.log;

// Filter function
window.zapDebugFilter = (...args) => {
  const msg = JSON.stringify(args);
  if (
    msg.includes('[FetchZapReceipt]') ||
    msg.includes('[SparkWallet] enrichIncomingZaps') ||
    msg.includes('[SparkWallet] Processing payment') ||
    msg.includes('[SparkWallet] Enrichment result') ||
    msg.includes('[SparkWallet] Finished enriching') ||
    msg.includes('[BreezWallet]')
  ) {
    originalLog.apply(console, args);
  }
};

// Override console.log temporarily
console.log = window.zapDebugFilter;

console.log('🔍 Zap enrichment debug filter active. Refresh the page now.');
console.log('To disable: console.log = originalLog');
```

Then refresh the page.

## Expected Log Flow

If working correctly, you should see:

1. **Enrichment Start**
   ```
   [SparkWallet] enrichIncomingZaps called with: {totalPayments: X, ...}
   [SparkWallet] Filtered incoming payments: {count: X, ...}
   ```

2. **For Each Incoming Payment**
   ```
   [SparkWallet] Processing payment 019aae...
   [BreezWallet] fetchZapReceiptForPayment called: {...}
   [BreezWallet] Invoice: lnbc100n1p5jycgupp5jejt...
   [BreezWallet] Importing fetchZapReceipts module...
   [BreezWallet] Module imported successfully
   [BreezWallet] Calling fetchZapReceiptForInvoice...
   ```

3. **Relay Queries**
   ```
   [FetchZapReceipt] fetchZapReceiptForInvoice called: {...}
   [FetchZapReceipt] Starting relay queries...
   [FetchZapReceipt] Connecting to wss://relay.primal.net...
   [FetchZapReceipt] ✓ Connected to wss://relay.primal.net
   [FetchZapReceipt] Subscribing to ... with filter: {...}
   [FetchZapReceipt] EOSE from wss://relay.primal.net
   [FetchZapReceipt] Timeout for wss://relay.primal.net (if no match)
   ```

4. **Result**
   ```
   [FetchZapReceipt] All relay queries completed
   [FetchZapReceipt] ✅ Zap receipt fetched successfully (if found)
   [BreezWallet] fetchZapReceiptForInvoice returned: Found/Not found
   [SparkWallet] Enrichment result for 019aae...: {wasEnriched: true, ...}
   [SparkWallet] ✓ UI updated for payment 019aae...
   ```

5. **Completion**
   ```
   [SparkWallet] Finished enriching incoming zaps
   ```

## Common Issues

### Issue 1: Logs stop after "fetchZapReceiptForPayment called"
**Symptom**: No "Invoice:" or "Importing fetchZapReceipts module..." logs
**Cause**: Function returning early due to failed checks
**Debug**: Check if payment actually has `invoice` field

### Issue 2: No relay connection logs
**Symptom**: No "Connecting to wss://..." logs
**Cause**: Module import or function call failing
**Debug**: Check browser console for errors (not just logs)

### Issue 3: Relay connects but no events
**Symptom**: "Connected" but no "Received event" logs
**Cause**: No zap receipts exist for this user on relays
**Expected**: This is normal if zaps were sent from wallets that don't publish receipts

## Manual Test

To test a specific payment, paste this in console:

```javascript
// Replace with your actual values
const testInvoice = 'lnbc100n1p5jycgupp5jejt...'; // From payment
const userPubkey = 'ee6ea13ab9fe5c4a...'; // Your pubkey

import('./lib/spark/fetchZapReceipts').then(module => {
  module.fetchZapReceiptForInvoice(testInvoice, userPubkey)
    .then(result => {
      console.log('✅ Manual test result:', result);
    })
    .catch(error => {
      console.error('❌ Manual test error:', error);
    });
});
```

## Restore Normal Logging

```javascript
console.log = originalLog;
console.log('✅ Normal logging restored');
```
