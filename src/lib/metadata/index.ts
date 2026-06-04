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
import { projectEntity } from "./entities/project";
import { milestoneEntity } from "./entities/milestone";
import { timesheetEntity } from "./entities/timesheet";
import { campaignEntity } from "./entities/campaign";
import { ticketEntity } from "./entities/ticket";
import { departmentEntity } from "./entities/department";
import { employeeEntity } from "./entities/employee";
import { noteEntity } from "./entities/note";
import { todoEntity } from "./entities/todo";
import { callEntity } from "./entities/call";
import { postEntity } from "./entities/post";
import { fileEntity } from "./entities/file";
import { chatMessageEntity } from "./entities/chat-message";
import { emailEntity } from "./entities/email";
import { positionEntity } from "./entities/position";
import { userEntity } from "./entities/user";
import { userSettingEntity } from "./entities/user-setting";
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
  // projects
  projectEntity,
  milestoneEntity,
  timesheetEntity,
  // marketing
  campaignEntity,
  // support
  ticketEntity,
  // people
  departmentEntity,
  employeeEntity,
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
  postEntity,
  fileEntity,
  chatMessageEntity,
  emailEntity,
  // auth / access control
  positionEntity,
  userEntity,
  userSettingEntity,
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
