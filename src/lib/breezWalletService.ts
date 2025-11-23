import initBreezSDK, {
  BreezSdk,
  connect,
  defaultConfig,
  ConnectRequest,
  Config,
  Network,
  Seed,
  GetInfoResponse,
  SendPaymentRequest,
  SendPaymentResponse,
  ReceivePaymentRequest,
  ReceivePaymentResponse,
  Payment,
  ListPaymentsRequest,
  ListPaymentsResponse,
  SdkEvent,
  EventListener,
  PrepareSendPaymentRequest,
  PrepareSendPaymentResponse,
  LightningAddressInfo,
  RegisterLightningAddressRequest,
  CheckLightningAddressRequest,
} from '@breeztech/breez-sdk-spark/web';
import { logError, logInfo, logWarning } from './logger';
import { getZapData } from './zap';

/**
 * Breez Wallet Service
 *
 * Singleton service for managing Breez SDK Spark integration in Primal Web.
 * Provides Lightning wallet functionality including payments, invoices, and balance management.
 */

export type BreezWalletState = {
  isInitialized: boolean;
  isConnected: boolean;
  balance: number; // Balance in sats
  tokenBalances: Map<string, any>; // Token balances if any
  lastSynced?: Date;
};

export type BreezPaymentInfo = {
  id: string;
  amount: number; // Amount in sats (absolute value)
  fees: number; // Fee amount in sats
  paymentType: 'send' | 'receive'; // Payment direction
  status: 'completed' | 'pending' | 'failed';
  timestamp: number;
  description?: string;
  invoice?: string;
  preimage?: string;
  paymentHash?: string;

  // Zap-specific fields (NIP-57)
  isZap?: boolean; // True if this payment is a Nostr zap
  zapSenderPubkey?: string; // Sender's nostr pubkey (hex)
  zapRecipientPubkey?: string; // Recipient's nostr pubkey (hex)
  zapComment?: string; // Zap comment/message
  zapEventId?: string; // Event ID if zapping a note
};

type BreezEventHandler = (event: SdkEvent) => void;

class BreezWalletService {
  private sdk: BreezSdk | null = null;
  private wasmInitialized: boolean = false;
  private eventListeners: Map<string, BreezEventHandler> = new Map();
  private state: BreezWalletState = {
    isInitialized: false,
    isConnected: false,
    balance: 0,
    tokenBalances: new Map(),
  };

  /**
   * Initialize the WASM module (only needs to be done once)
   */
  private async initWasm(): Promise<void> {
    if (this.wasmInitialized) return;

    try {
      logInfo('[BreezWallet] Initializing WASM module...');
      await initBreezSDK();
      this.wasmInitialized = true;
      logInfo('[BreezWallet] WASM module initialized');
    } catch (error) {
      logError('[BreezWallet] Failed to initialize WASM:', error);
      throw new Error(`Failed to initialize Breez SDK WASM: ${error}`);
    }
  }

  /**
   * Connect to Breez SDK with the provided mnemonic
   * @param mnemonic - BIP39 mnemonic seed phrase
   * @param network - Bitcoin network (default: bitcoin mainnet)
   * @param apiKey - Breez API key (optional, from env by default)
   */
  async connect(
    mnemonic: string,
    network: Network = 'mainnet',
    apiKey?: string
  ): Promise<void> {
    try {
      // Initialize WASM first
      logInfo('[BreezWallet] Step 1/4: Initializing WASM module...');
      await this.initWasm();

      logInfo('[BreezWallet] Step 2/4: Connecting to Breez SDK...');

      // Get API key from environment or parameter
      const key = apiKey || import.meta.env.VITE_BREEZ_API_KEY;

      if (!key || key === 'YOUR_BREEZ_API_KEY_HERE') {
        throw new Error('Breez API key not configured. Please set VITE_BREEZ_API_KEY in .env');
      }

      // Create default configuration
      const config: Config = defaultConfig(network);
      config.apiKey = key;
      config.privateEnabledDefault = true; // Enable privacy mode by default

      // For web implementation, real-time sync is optional
      // Leave realTimeSyncServerUrl undefined to disable it
      config.realTimeSyncServerUrl = undefined;

      // Create seed from mnemonic
      const seed: Seed = {
        type: 'mnemonic',
        mnemonic: mnemonic,
      };

      // Storage directory for web (uses IndexedDB)
      const storageDir = 'breez-spark-wallet';

      // Connect to SDK
      const connectRequest: ConnectRequest = {
        config,
        seed,
        storageDir,
      };

      this.sdk = await connect(connectRequest);

      this.state.isConnected = true;
      this.state.isInitialized = true;

      logInfo('[BreezWallet] Step 3/4: Connected to SDK, syncing balance...');

      // Initial balance sync
      await this.syncBalance();

      logInfo('[BreezWallet] Step 4/4: Setting up event listeners...');

      // Set up default event listener for SDK events
      this.setupDefaultEventListener();

      logInfo('[BreezWallet] ✓ Wallet restored successfully! Balance:', this.state.balance, 'sats');

    } catch (error) {
      logError('[BreezWallet] Connection failed:', error);
      this.state.isConnected = false;
      throw error;
    }
  }

  /**
   * Disconnect from Breez SDK
   */
  async disconnect(): Promise<void> {
    if (!this.sdk) {
      logWarning('[BreezWallet] No SDK instance to disconnect');
      return;
    }

    try {
      logInfo('[BreezWallet] Disconnecting...');

      // Remove all event listeners
      for (const [id, _] of this.eventListeners) {
        await this.sdk.removeEventListener(id);
      }
      this.eventListeners.clear();

      // Disconnect SDK
      await this.sdk.disconnect();
      this.sdk = null;

      this.state.isConnected = false;
      this.state.balance = 0;
      this.state.tokenBalances.clear();

      logInfo('[BreezWallet] Disconnected successfully');
    } catch (error) {
      logError('[BreezWallet] Disconnect failed:', error);
      throw error;
    }
  }

  /**
   * Get current wallet state
   */
  getState(): BreezWalletState {
    return { ...this.state };
  }

  /**
   * Check if wallet is connected
   */
  isConnected(): boolean {
    return this.state.isConnected && this.sdk !== null;
  }

  /**
   * Get current balance in sats
   */
  async getBalance(): Promise<number> {
    await this.ensureConnected();
    await this.syncBalance();
    return this.state.balance;
  }

  /**
   * Sync balance from SDK
   */
  private async syncBalance(): Promise<void> {
    await this.ensureConnected();

    try {
      const info: GetInfoResponse = await this.sdk!.getInfo({ ensureSynced: true });
      this.state.balance = info.balanceSats;
      this.state.tokenBalances = info.tokenBalances;
      this.state.lastSynced = new Date();

      logInfo(`[BreezWallet] Balance synced: ${info.balanceSats} sats`);
    } catch (error) {
      logError('[BreezWallet] Failed to sync balance:', error);
      throw error;
    }
  }

  /**
   * Send a Lightning payment
   * @param invoice - BOLT11 invoice string
   * @returns Payment response
   */
  async sendPayment(invoice: string): Promise<BreezPaymentInfo> {
    await this.ensureConnected();

    try {
      logInfo('[BreezWallet] Sending payment...');

      // Prepare the payment first to validate and get details
      const prepareRequest: PrepareSendPaymentRequest = {
        paymentRequest: invoice,
      };

      const prepareResponse: PrepareSendPaymentResponse = await this.sdk!.prepareSendPayment(prepareRequest);

      // Execute the payment
      const sendRequest: SendPaymentRequest = {
        prepareResponse,
      };

      const response: SendPaymentResponse = await this.sdk!.sendPayment(sendRequest);

      logInfo('[BreezWallet] Payment sent successfully');

      // Update balance after payment
      await this.syncBalance();

      return this.mapPaymentToInfo(response.payment);
    } catch (error) {
      logError('[BreezWallet] Payment failed:', error);
      throw error;
    }
  }

  /**
   * Create an invoice to receive payment
   * @param amountSats - Amount in satoshis
   * @param description - Invoice description
   * @returns Invoice string (BOLT11)
   */
  async createInvoice(amountSats: number, description?: string): Promise<string> {
    await this.ensureConnected();

    try {
      logInfo(`[BreezWallet] Creating invoice for ${amountSats} sats`);

      const request: ReceivePaymentRequest = {
        paymentMethod: {
          type: 'bolt11Invoice',
          description: description || '',
          amountSats,
        },
      };

      const response: ReceivePaymentResponse = await this.sdk!.receivePayment(request);

      logInfo('[BreezWallet] Invoice created');

      return response.paymentRequest;
    } catch (error) {
      logError('[BreezWallet] Failed to create invoice:', error);
      throw error;
    }
  }

  /**
   * Get payment history
   * @param limit - Maximum number of payments to return
   * @param offset - Offset for pagination
   * @returns Array of payment info
   */
  async getPaymentHistory(limit: number = 50, offset: number = 0): Promise<BreezPaymentInfo[]> {
    await this.ensureConnected();

    try {
      const request: ListPaymentsRequest = {
        fromTimestamp: undefined,
        toTimestamp: undefined,
        limit,
        offset,
      };

      const response: ListPaymentsResponse = await this.sdk!.listPayments(request);

      return response.payments.map(payment => this.mapPaymentToInfo(payment));
    } catch (error) {
      logError('[BreezWallet] Failed to get payment history:', error);
      throw error;
    }
  }

  /**
   * Add event listener for SDK events
   * @param handler - Event handler function
   * @returns Listener ID (for removal)
   */
  async addEventListener(handler: BreezEventHandler): Promise<string> {
    await this.ensureConnected();

    try {
      const listener: EventListener = {
        onEvent: (event: SdkEvent) => {
          handler(event);
        },
      };

      const id = await this.sdk!.addEventListener(listener);
      this.eventListeners.set(id, handler);

      logInfo(`[BreezWallet] Event listener added: ${id}`);
      return id;
    } catch (error) {
      logError('[BreezWallet] Failed to add event listener:', error);
      throw error;
    }
  }

  /**
   * Remove event listener
   * @param id - Listener ID
   */
  async removeEventListener(id: string): Promise<void> {
    await this.ensureConnected();

    try {
      await this.sdk!.removeEventListener(id);
      this.eventListeners.delete(id);
      logInfo(`[BreezWallet] Event listener removed: ${id}`);
    } catch (error) {
      logError('[BreezWallet] Failed to remove event listener:', error);
      throw error;
    }
  }

  /**
   * Set up default event listener for important events
   */
  private setupDefaultEventListener(): void {
    if (!this.sdk) return;

    this.addEventListener((event: SdkEvent) => {
      switch (event.type) {
        case 'synced':
          logInfo('[BreezWallet] Wallet synced');
          this.syncBalance();
          break;

        case 'dataSynced':
          logInfo(`[BreezWallet] Data synced (new records: ${event.didPullNewRecords})`);
          if (event.didPullNewRecords) {
            this.syncBalance();
          }
          break;

        case 'paymentSucceeded':
          logInfo('[BreezWallet] Payment succeeded');
          this.syncBalance();
          break;

        case 'paymentFailed':
          logWarning('[BreezWallet] Payment failed');
          this.syncBalance();
          break;

        case 'unclaimedDeposits':
          logInfo(`[BreezWallet] Unclaimed deposits: ${event.unclaimedDeposits.length}`);
          break;

        case 'claimedDeposits':
          logInfo(`[BreezWallet] Claimed deposits: ${event.claimedDeposits.length}`);
          this.syncBalance();
          break;
      }
    }).catch(error => {
      logError('[BreezWallet] Failed to set up default event listener:', error);
    });
  }

  /**
   * Sync wallet state
   */
  async syncWallet(): Promise<void> {
    await this.ensureConnected();

    try {
      logInfo('[BreezWallet] Syncing wallet...');
      await this.sdk!.syncWallet({});
      await this.syncBalance();
      logInfo('[BreezWallet] Wallet synced');
    } catch (error) {
      logError('[BreezWallet] Wallet sync failed:', error);
      throw error;
    }
  }

  /**
   * Parse Lightning input (invoice, LNURL, Lightning address, etc.)
   * @param input - Input string to parse
   * @returns Parsed input type
   */
  async parseInput(input: string): Promise<any> {
    await this.ensureConnected();

    try {
      return await this.sdk!.parse(input);
    } catch (error) {
      logError('[BreezWallet] Failed to parse input:', error);
      throw error;
    }
  }

  /**
   * Prepare an LNURL pay request
   * @param amountSats - Amount in sats
   * @param payRequest - LNURL pay request details (from parseInput)
   * @param comment - Optional comment
   * @returns Prepared LNURL pay response
   */
  async prepareLnurlPay(
    amountSats: number,
    payRequest: any,
    comment?: string
  ): Promise<any> {
    await this.ensureConnected();

    try {
      const request = {
        amountSats,
        payRequest,
        comment,
        validateSuccessActionUrl: true,
      };

      return await this.sdk!.prepareLnurlPay(request);
    } catch (error) {
      logError('[BreezWallet] Failed to prepare LNURL pay:', error);
      throw error;
    }
  }

  /**
   * Execute an LNURL pay request
   * @param prepareResponse - Response from prepareLnurlPay
   * @returns LNURL pay response with payment info
   */
  async lnurlPay(prepareResponse: any): Promise<any> {
    await this.ensureConnected();

    try {
      const request = {
        prepareResponse,
      };

      return await this.sdk!.lnurlPay(request);
    } catch (error) {
      logError('[BreezWallet] Failed to execute LNURL pay:', error);
      throw error;
    }
  }

  /**
   * Generate a new BIP39 mnemonic seed phrase
   * Note: This uses the browser's crypto.getRandomValues() for entropy
   * @returns 12-word mnemonic
   */
  static async generateMnemonic(): Promise<string> {
    // For now, we'll need to use a BIP39 library
    // The Breez SDK doesn't provide mnemonic generation directly
    // We can add @scure/bip39 library for this
    throw new Error('Mnemonic generation not yet implemented. Please use an external BIP39 library.');
  }

  /**
   * Get Lightning address for this wallet
   * @returns Lightning address info or undefined if not registered
   */
  async getLightningAddress(): Promise<LightningAddressInfo | undefined> {
    await this.ensureConnected();

    try {
      logInfo('[BreezWallet] Getting Lightning address...');
      const address = await this.sdk!.getLightningAddress();
      if (address) {
        logInfo(`[BreezWallet] Lightning address: ${address.lightningAddress}`);
      } else {
        logInfo('[BreezWallet] No Lightning address registered');
      }
      return address;
    } catch (error) {
      logError('[BreezWallet] Failed to get Lightning address:', error);
      throw error;
    }
  }

  /**
   * Check if a Lightning address username is available
   * @param username - Username to check (without domain)
   * @returns True if available, false if taken
   */
  async checkLightningAddressAvailable(username: string): Promise<boolean> {
    await this.ensureConnected();

    try {
      logInfo(`[BreezWallet] Checking availability for username: ${username}`);
      const request: CheckLightningAddressRequest = { username };
      const available = await this.sdk!.checkLightningAddressAvailable(request);
      logInfo(`[BreezWallet] Username ${username} available: ${available}`);
      return available;
    } catch (error) {
      logError('[BreezWallet] Failed to check Lightning address availability:', error);
      throw error;
    }
  }

  /**
   * Register a Lightning address for this wallet
   * @param username - Desired username (without domain)
   * @param description - Optional description
   * @returns Lightning address info
   */
  async registerLightningAddress(username: string, description?: string): Promise<LightningAddressInfo> {
    await this.ensureConnected();

    try {
      logInfo(`[BreezWallet] Registering Lightning address: ${username}`);
      const request: RegisterLightningAddressRequest = {
        username,
        description,
      };
      const address = await this.sdk!.registerLightningAddress(request);
      logInfo(`[BreezWallet] Lightning address registered: ${address.lightningAddress}`);
      return address;
    } catch (error) {
      logError('[BreezWallet] Failed to register Lightning address:', error);
      throw error;
    }
  }

  /**
   * Delete the Lightning address for this wallet
   */
  async deleteLightningAddress(): Promise<void> {
    await this.ensureConnected();

    try {
      logInfo('[BreezWallet] Deleting Lightning address...');
      await this.sdk!.deleteLightningAddress();
      logInfo('[BreezWallet] Lightning address deleted');
    } catch (error) {
      logError('[BreezWallet] Failed to delete Lightning address:', error);
      throw error;
    }
  }

  /**
   * Ensure SDK is connected, throw error if not
   */
  private async ensureConnected(): Promise<void> {
    if (!this.sdk || !this.state.isConnected) {
      throw new Error('Breez wallet not connected. Call connect() first.');
    }
  }

  /**
   * Fetch zap receipt from Nostr relays for an incoming payment
   * This is needed for incoming zaps where we don't have the zap request locally
   */
  async fetchZapReceiptForPayment(
    payment: BreezPaymentInfo,
    userPubkey: string
  ): Promise<BreezPaymentInfo> {
    // Only fetch for incoming payments that don't already have zap data
    if (payment.paymentType !== 'receive' || payment.isZap || !payment.invoice) {
      return payment;
    }

    try {
      logInfo(`[BreezWallet] Fetching zap receipt for incoming payment ${payment.id}`);

      // Import dynamically to avoid circular dependencies
      const { fetchZapReceiptForInvoice } = await import('./spark/fetchZapReceipts');
      const zapReceipt = await fetchZapReceiptForInvoice(payment.invoice, userPubkey);

      if (zapReceipt) {
        // Enrich payment with zap data
        payment.isZap = true;
        payment.zapSenderPubkey = zapReceipt.senderPubkey;
        payment.zapRecipientPubkey = zapReceipt.recipientPubkey;
        payment.zapEventId = zapReceipt.eventId;
        payment.zapComment = zapReceipt.comment;

        logInfo(`[BreezWallet] ✓ Enriched incoming zap from relay data`);
        logInfo(`[BreezWallet]   Sender: ${payment.zapSenderPubkey?.slice(0, 16)}...`);
        logInfo(`[BreezWallet]   Event: ${payment.zapEventId || 'none (profile zap)'}`);
      }

      return payment;
    } catch (error) {
      logError('[BreezWallet] Failed to fetch zap receipt from relays:', error);
      return payment;
    }
  }

  /**
   * Enrich payment with zap data from NIP-57 zap request
   * Parses the payment description to extract zap request details,
   * or retrieves from localStorage if description doesn't contain zap request
   */
  private enrichPaymentWithZapData(payment: BreezPaymentInfo): BreezPaymentInfo {
    // First try: Check if payment hash has zap data in localStorage
    if (payment.paymentHash) {
      console.log(`[BreezWallet ZAP DEBUG] Payment ${payment.id} has paymentHash: ${payment.paymentHash}`);
      try {
        const zapData = getZapData(payment.paymentHash);
        console.log(`[BreezWallet ZAP DEBUG] localStorage lookup result:`, zapData ? 'FOUND' : 'NOT FOUND');
        if (zapData) {
          console.log(`[BreezWallet ZAP DEBUG] Found zap data in localStorage for payment ${payment.id}`);
          payment.isZap = true;
          payment.zapSenderPubkey = zapData.zapRequest.pubkey;
          payment.zapRecipientPubkey = zapData.recipientPubkey;
          payment.zapComment = zapData.zapRequest.content || '';

          // Extract event ID from tags
          const eTag = zapData.zapRequest.tags?.find((t: string[]) => t[0] === 'e');
          if (eTag && eTag[1]) {
            payment.zapEventId = eTag[1];
          }

          logInfo(`[BreezWallet] ✓ Enriched zap payment from localStorage: ${payment.id}`);
          logInfo(`[BreezWallet]   Sender: ${payment.zapSenderPubkey?.slice(0, 16)}...`);
          logInfo(`[BreezWallet]   Recipient: ${payment.zapRecipientPubkey?.slice(0, 16)}...`);
          logInfo(`[BreezWallet]   Event: ${payment.zapEventId || 'none (profile zap)'}`);
          logInfo(`[BreezWallet]   Comment: ${payment.zapComment || 'none'}`);

          // If we found zap data in localStorage, we're done
          return payment;
        }
      } catch (error) {
        console.warn('[BreezWallet] Failed to check localStorage for zap data:', error);
      }
    } else {
      console.log(`[BreezWallet ZAP DEBUG] Payment ${payment.id} has NO paymentHash`);
    }

    // Second try: Parse description as JSON (for invoices that have zap request embedded)
    if (!payment.description) {
      console.log(`[BreezWallet ZAP DEBUG] Payment ${payment.id} has NO description`);
      return payment;
    }

    console.log(`[BreezWallet ZAP DEBUG] Processing payment ${payment.id}`);
    console.log(`[BreezWallet ZAP DEBUG] Description length: ${payment.description.length} chars`);
    console.log(`[BreezWallet ZAP DEBUG] Description:`, payment.description);

    try {
      // Try to parse description as JSON (zap requests are kind 9734 Nostr events)
      const zapRequest = JSON.parse(payment.description);

      logInfo(`[BreezWallet] Parsed JSON - kind: ${zapRequest.kind}`);

      // Check if it's a valid zap request (kind 9734)
      if (zapRequest.kind !== 9734) {
        logInfo(`[BreezWallet] Not a zap request (kind ${zapRequest.kind})`);
        return payment;
      }

      // Extract zap data from the zap request event
      payment.isZap = true;

      // Sender is the pubkey who created the zap request
      if (zapRequest.pubkey) {
        payment.zapSenderPubkey = zapRequest.pubkey;
      }

      // Recipient is in the 'p' tag
      const pTag = zapRequest.tags?.find((t: string[]) => t[0] === 'p');
      if (pTag && pTag[1]) {
        payment.zapRecipientPubkey = pTag[1];
      }

      // Event being zapped is in the 'e' tag (optional)
      const eTag = zapRequest.tags?.find((t: string[]) => t[0] === 'e');
      if (eTag && eTag[1]) {
        payment.zapEventId = eTag[1];
      }

      // Comment/message is in the content field
      if (zapRequest.content) {
        payment.zapComment = zapRequest.content;
      }

      logInfo(`[BreezWallet] ✓ Enriched zap payment from description: ${payment.id}`);
      logInfo(`[BreezWallet]   Sender: ${payment.zapSenderPubkey?.slice(0, 16)}...`);
      logInfo(`[BreezWallet]   Recipient: ${payment.zapRecipientPubkey?.slice(0, 16)}...`);
      logInfo(`[BreezWallet]   Event: ${payment.zapEventId || 'none (profile zap)'}`);
      logInfo(`[BreezWallet]   Comment: ${payment.zapComment || 'none'}`);
    } catch (error) {
      // Not a JSON description or not a valid zap request - that's okay
      // This is normal for regular Lightning payments
      logInfo(`[BreezWallet] Description is not JSON or not a zap request (normal for regular payments)`);
    }

    return payment;
  }

  /**
   * Map SDK Payment to simplified BreezPaymentInfo
   */
  private mapPaymentToInfo(payment: Payment): BreezPaymentInfo {
    const info: BreezPaymentInfo = {
      id: payment.id,
      amount: Number(payment.amount),
      fees: Number(payment.fees),
      paymentType: payment.paymentType, // 'sent' or 'received'
      status: payment.status,
      timestamp: payment.timestamp,
    };

    // Extract additional details based on payment type
    if (payment.details) {
      if (payment.details.type === 'lightning') {
        info.invoice = payment.details.invoice;
        info.preimage = payment.details.preimage;
        info.paymentHash = payment.details.paymentHash;
        info.description = payment.details.description;
      } else if (payment.details.type === 'spark' && payment.details.invoiceDetails) {
        info.invoice = payment.details.invoiceDetails.invoice;
        info.description = payment.details.invoiceDetails.description;
      }
    }

    // Enrich with zap data if this is a zap payment
    return this.enrichPaymentWithZapData(info);
  }
}

// Export singleton instance
export const breezWallet = new BreezWalletService();
