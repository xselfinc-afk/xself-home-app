/**
 * Delivery (GIGA one-click dropship) types — Buyer account 82482447.
 *
 * SERVER-SHAPE ONLY. No secrets, no network. These describe the dropship request we
 * will eventually send via the GIGA Delivery account API (`/buyer/order/dropShip-sync/v1`)
 * and the supplier-order record we persist afterward.
 *
 * 🔒 Pickup (Buyer 76938981) is a SEPARATE account with LOCKED rules — see
 * docs/fulfillment-rules.md. Delivery must never reuse Pickup credentials, and the
 * customer-facing label stays "Delivery" (never "Shipping"). See docs/delivery-architecture.md.
 */

/** Recipient ship-to block (GIGA dropship: US only at present; no Chinese/Arabic chars). */
export interface DeliveryShipTo {
  shipName: string;        // 1–40 chars
  shipPhone: string;       // 6–15 digits (separators allowed)
  shipEmail?: string;      // optional, ≤90 chars
  shipAddress1: string;    // ≤35 chars, no P.O. Box
  shipAddress2?: string;   // ≤35 chars
  shipCity: string;
  shipState?: string;      // required for US/JP
  shipZipCode: string;
  shipCountry: string;     // dropShip-sync currently supports US
}

/** A single line of the dropship order. */
export interface DeliveryOrderLine {
  sku: string;             // GIGA Item Code
  qty: number;
  itemPrice: number;       // dollars (not cents)
  productName?: string;
  itemTax?: number;
  itemUnitDiscount?: number;
  currencyCode?: 'USD' | 'GBP' | 'EUR' | 'JPY' | 'CAD';
}

/** US delivery service level (GIGA `deliveryService`). DSR = small parcel; the rest = LTL. */
export type DeliveryServiceLevel = 'DSR' | 'NSR' | 'TRHD' | 'ROC' | 'WG';

/** Full dropship submission payload (maps to dropShip-sync/v1 request body). */
export interface DeliveryDropshipInput {
  orderDate: string;            // "YYYY-MM-DD HH:mm:ss"
  orderNo: string;              // our shipment id; letters/numbers/-/_ only; unique
  shipTo: DeliveryShipTo;
  orderLines: DeliveryOrderLine[];
  orderTotal?: number;
  deliveryService?: DeliveryServiceLevel;  // the "shipServiceLevel"
  salesChannel?: string;
  orderFrom?: string;
  customerComments?: string;
}

/**
 * Supplier-order record we persist on our order AFTER payment + admin approval and a
 * successful (sandbox-verified) dropship submission. dropShip-sync returns no id
 * (`data:null`), so supplier_order_id / carrier / tracking come from the Order Status
 * Query endpoint, polled later.
 */
export interface DeliverySupplierRecord {
  supplier_account: 'delivery';          // 🔒 must never be 'pickup'
  supplier_order_no: string;             // the orderNo we submitted
  supplier_order_id: string | null;      // from Order Status Query
  supplier_order_status: string | null;  // from Order Status Query
  carrier: string | null;
  tracking_number: string | null;
}
