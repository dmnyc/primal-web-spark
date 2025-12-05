# Breez SDK 0.5.2 Upgrade Notes

## Issue: Wallet Hanging on Load

When upgrading from Breez SDK 0.4.2 to 0.5.2, the wallet may hang during loading due to incompatible IndexedDB storage formats.

## Emergency Reset (If Wallet is Stuck)

If your wallet is stuck on "Loading wallet..." with no errors:

### Method 1: Console Command (Easiest)

1. Open browser DevTools (F12 or Cmd+Option+I)
2. Go to the **Console** tab
3. Type this command and press Enter:
   ```javascript
   window.resetBreezWallet()
   ```
4. Wait for the page to reload
5. Restore your wallet with your mnemonic

### Method 2: Manual Reset

1. Open browser DevTools (F12)
2. Go to **Application** tab
3. **IndexedDB** section:
   - Expand IndexedDB
   - Delete `breez-spark-wallet` database
   - Delete any other `breez` or `spark` databases
4. **Local Storage** section:
   - Click on your domain
   - Delete all keys starting with `breez_` or `spark_`
5. Reload the page
6. Restore your wallet with your mnemonic

## What Changed

### Version 0.4.2 → 0.5.2

**New Features:**
- ✅ Zap description field now populated (fixes issue #397)
- ✅ Nostr zap support in private mode
- ✅ Zap receipt publishing
- ✅ LNURL comment support

**Breaking Change:**
- IndexedDB storage format changed
- Old 0.4.2 data causes SDK to hang during initialization
- **Solution**: Clear storage and restore from mnemonic

## Automatic Migration

The code now includes automatic storage clearing:
- Detects version change (0.4.2 → 0.5.2)
- Attempts to clear old IndexedDB automatically
- However, if SDK hangs before our code runs, use manual reset above

## For Developers

If you need to test the upgrade:

1. **On first 0.5.2 load**, check console for:
   ```
   [BreezWallet] Detected SDK version change - clearing old storage
   [BreezWallet] Storage cleared successfully
   ```

2. **If wallet hangs**, use emergency reset

3. **Report issues** to Breez team with console logs

## Reporting Issues to Breez

If you encounter issues, send these details to the Breez team:

- SDK Version: 0.5.2
- Platform: Web (WASM)
- Browser: [Your browser]
- Issue: Wallet hangs during loading after upgrade from 0.4.2
- Console output: [Copy all console messages]
- GitHub Issue: https://github.com/breez/spark-sdk/issues/397

## Rollback Instructions

If 0.5.2 is not working and you need to rollback:

```bash
git checkout main
npm install
npm run build
```

This will revert to SDK 0.4.2.
