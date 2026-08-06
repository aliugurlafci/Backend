import type { EntityDef } from "../types";
import { branchRef, currencyField, moneyTotals, notesField, numberField } from "./shared";

/**
 * Sales cart / basket — a persisted draft of an over-the-counter sale, workable
 * two ways:
 *
 *  1. **Send to the register** (`send`): the basket is handed to the cash desk
 *     with a short numeric pickup `code` the cashier types to find it. The
 *     cashier then takes payment (`checkout`), closes it to the customer's
 *     account (`credit`), parks it (`suspend`) or rejects it (`cancel`).
 *  2. **Ring it up directly** (`checkout` from `open`) — the original flow, still
 *     available to anyone holding `cart:checkout`.
 *
 * Both endings go through the POS service (invoice → send: posts AR/Revenue/COGS
 * and issues stock), so the cart never duplicates GL/stock logic. Off the
 * auto-nav; surfaced by the bespoke `/cart` screen (sale + register queue).
 */
export const cartEntity: EntityDef = {
  name: "cart",
  label: "Cart",
  pluralLabel: "Carts",
  icon: "cart",
  group: "sales",
  titleField: "number",
  system: true,
  ownable: true,
  fields: [
    numberField("Cart #"),
    /**
     * Register pickup code — a small integer (1…99 999 999) the cashier types to
     * pull the basket up. Assigned on `send`, and only unique among *active*
     * (sent/suspended) carts: a closed cart frees its number for reuse, so the
     * codes in circulation stay short. Server-assigned, never client-supplied.
     */
    { name: "code", label: "Cart No", type: "number", computed: true, filterable: true, sortable: true },
    { name: "accountId", label: "Customer", type: "reference", referenceEntity: "account", filterable: true },
    branchRef(),
    { name: "warehouseId", label: "Warehouse", type: "reference", referenceEntity: "warehouse", filterable: true },
    currencyField(),
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "open",
      options: [
        { value: "open", label: "Open", tone: "info" },
        { value: "sent", label: "At Register", tone: "warning" },
        { value: "suspended", label: "Suspended", tone: "neutral" },
        { value: "converted", label: "Closed", tone: "success" },
        { value: "cancelled", label: "Cancelled", tone: "danger" },
      ],
    },
    { name: "convertedInvoiceId", label: "Invoice", type: "reference", referenceEntity: "invoice" },
    /** How the cart was closed: tendered at the register, or left on account. */
    {
      name: "settlement",
      label: "Settlement",
      type: "enum",
      computed: true,
      filterable: true,
      options: [
        { value: "paid", label: "Paid", tone: "success" },
        { value: "credit", label: "On Account", tone: "warning" },
      ],
    },
    /**
     * Display name of whoever built the basket, denormalized so the cashier sees
     * it without needing `user:read` (the system `createdBy` only holds the id).
     */
    { name: "createdByName", label: "Created By", type: "string", computed: true, searchable: true },
    { name: "sentAt", label: "Sent At", type: "datetime", computed: true, sortable: true },
    { name: "closedByName", label: "Closed By", type: "string", computed: true },
    { name: "closedAt", label: "Closed At", type: "datetime", computed: true, sortable: true },
    ...moneyTotals(),
    notesField(),
  ],
  /**
   * Lifecycle — also the permission surface: each transition's `requires` grant
   * shows up as a tickable operation on the cart row of Settings → Permissions,
   * which is how the two cart modes are enabled per position (`cart:send` for
   * "send to register", `cart:checkout` for ringing it up).
   */
  lifecycle: {
    field: "status",
    initial: "open",
    states: ["open", "sent", "suspended", "converted", "cancelled"],
    finalStates: ["converted", "cancelled"],
    transitions: [
      { from: "open", to: "sent", action: "send", requires: "cart:send" },
      { from: "sent", to: "suspended", action: "suspend", requires: "cart:suspend" },
      { from: "suspended", to: "sent", action: "resume", requires: "cart:suspend" },
      { from: "open", to: "converted", action: "checkout", requires: "cart:checkout" },
      { from: "sent", to: "converted", action: "checkout", requires: "cart:checkout" },
      { from: "suspended", to: "converted", action: "checkout", requires: "cart:checkout" },
      { from: "open", to: "converted", action: "credit", requires: "cart:credit" },
      { from: "sent", to: "converted", action: "credit", requires: "cart:credit" },
      { from: "suspended", to: "converted", action: "credit", requires: "cart:credit" },
      { from: "open", to: "cancelled", action: "cancel", requires: "cart:cancel" },
      { from: "sent", to: "cancelled", action: "cancel", requires: "cart:cancel" },
      { from: "suspended", to: "cancelled", action: "cancel", requires: "cart:cancel" },
    ],
  },
  listColumns: [
    { field: "code", width: 100 },
    { field: "number", width: 120 },
    { field: "accountId", width: 200 },
    { field: "createdByName", width: 160 },
    { field: "status", width: 120 },
    { field: "total", width: 140 },
  ],
};
