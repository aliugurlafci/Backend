/**
 * Phase 2 — Metadata bootstrap.
 *
 * Registers the CRM entities, validates them, and publishes version 1 so the
 * resolver has an active version at import time. Editing metadata at runtime
 * goes through `metadataRegistry.createDraft` + governed `publish` (Phase 14).
 */
import { systemClock } from "@/lib/core/clock";
import { MetadataRegistry } from "./registry";
import { MetadataResolver } from "./resolver";
import { accountEntity } from "./entities/account";
import { contactEntity } from "./entities/contact";
import { dealEntity } from "./entities/deal";
import { taskEntity } from "./entities/task";
import { leadEntity } from "./entities/lead";
import { productEntity } from "./entities/product";
import { currencyEntity } from "./entities/currency";
import { taxRateEntity } from "./entities/tax-rate";
import { quoteEntity } from "./entities/quote";
import { quoteLineEntity } from "./entities/quote-line";
import { invoiceEntity } from "./entities/invoice";
import { invoiceLineEntity } from "./entities/invoice-line";
import { paymentEntity } from "./entities/payment";
import { recurringPlanEntity } from "./entities/recurring-plan";
import { proposalEntity } from "./entities/proposal";
import { estimationEntity } from "./entities/estimation";
import { contractEntity } from "./entities/contract";
import { salesOrderEntity } from "./entities/sales-order";
import { branchEntity } from "./entities/branch";
import { dealerEntity } from "./entities/dealer";
import { warehouseEntity } from "./entities/warehouse";
import { supplierEntity } from "./entities/supplier";
import { stockMovementEntity } from "./entities/stock-movement";
import { purchaseOrderEntity } from "./entities/purchase-order";
import { purchaseOrderLineEntity } from "./entities/purchase-order-line";
import { goodsReceiptEntity } from "./entities/goods-receipt";
import { goodsReceiptLineEntity } from "./entities/goods-receipt-line";
import { ledgerAccountEntity } from "./entities/ledger-account";
import { fiscalPeriodEntity } from "./entities/fiscal-period";
import { journalEntryEntity } from "./entities/journal-entry";
import { journalLineEntity } from "./entities/journal-line";
import { vendorBillEntity } from "./entities/vendor-bill";
import { vendorBillLineEntity } from "./entities/vendor-bill-line";
import { billPaymentEntity } from "./entities/bill-payment";
import { stockTransferEntity } from "./entities/stock-transfer";
import { stockAdjustmentEntity } from "./entities/stock-adjustment";
import { labelTemplateEntity } from "./entities/label-template";
import { posSessionEntity } from "./entities/pos-session";
import { departmentEntity } from "./entities/department";
import { employeeEntity } from "./entities/employee";
import { noteEntity } from "./entities/note";
import { todoEntity } from "./entities/todo";
import { callEntity } from "./entities/call";
import { fileEntity } from "./entities/file";
import { chatMessageEntity } from "./entities/chat-message";
import { emailEntity } from "./entities/email";
import { calendarEventEntity } from "./entities/calendar-event";
import { positionEntity } from "./entities/position";
import { userEntity } from "./entities/user";
import { userSettingEntity } from "./entities/user-setting";
import {
  automationRuleEntity,
  automationRunEntity,
  automationQueueEntity,
  assignmentRuleEntity,
  automationSettingEntity,
  automationIntegrationEntity,
  systemSettingEntity,
} from "./entities/automation";
import type { EntityDef } from "./types";

export const crmEntities: EntityDef[] = [
  leadEntity,
  accountEntity,
  contactEntity,
  dealEntity,
  taskEntity,
  // sales
  proposalEntity,
  estimationEntity,
  contractEntity,
  salesOrderEntity,
  quoteEntity,
  quoteLineEntity,
  invoiceEntity,
  invoiceLineEntity,
  // branches & dealers
  branchEntity,
  dealerEntity,
  // people
  departmentEntity,
  employeeEntity,
  // inventory / purchasing
  warehouseEntity,
  supplierEntity,
  stockMovementEntity,
  purchaseOrderEntity,
  purchaseOrderLineEntity,
  goodsReceiptEntity,
  goodsReceiptLineEntity,
  stockTransferEntity,
  stockAdjustmentEntity,
  // barcode labels + POS
  labelTemplateEntity,
  posSessionEntity,
  // accounting
  ledgerAccountEntity,
  fiscalPeriodEntity,
  journalEntryEntity,
  journalLineEntity,
  vendorBillEntity,
  vendorBillLineEntity,
  billPaymentEntity,
  // finance / catalog
  productEntity,
  currencyEntity,
  taxRateEntity,
  paymentEntity,
  recurringPlanEntity,
  // productivity + comms (bespoke screens; system → hidden from auto-nav)
  noteEntity,
  todoEntity,
  callEntity,
  fileEntity,
  chatMessageEntity,
  emailEntity,
  calendarEventEntity,
  // auth / access control
  positionEntity,
  userEntity,
  userSettingEntity,
  // automation platform (system entities; admin-gated, off the auto-nav)
  automationRuleEntity,
  automationRunEntity,
  automationQueueEntity,
  assignmentRuleEntity,
  automationSettingEntity,
  automationIntegrationEntity,
  systemSettingEntity,
];

export const metadataRegistry = new MetadataRegistry();

const draft = metadataRegistry.createDraft(crmEntities);
metadataRegistry.publish(draft.version, "system", systemClock.isoNow());

export const metadata = new MetadataResolver(metadataRegistry);

export { MetadataRegistry } from "./registry";
export { MetadataResolver } from "./resolver";
export {
  buildCreateSchema,
  buildUpdateSchema,
  validateRecord,
} from "./validation";
export type { ValidationOutcome, FieldIssue } from "./validation";
export * from "./types";
