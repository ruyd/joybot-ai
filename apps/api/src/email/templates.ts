import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** What a sales call email can say: {{name}} in a subject or body is replaced with these. */
export const SALES_CALL_FIELDS = {
  first_name: 'The visitor’s first name',
  name: 'The visitor’s full name',
  call_title: 'The call’s title, e.g. Sales call',
  date: 'The date in the visitor’s time zone, e.g. Monday, October 12, 2026',
  time: 'The start time, e.g. 1:30 PM',
  time_zone: 'The visitor’s time zone, e.g. America/Chicago',
  duration: 'The call’s length in minutes, e.g. 30',
  host_name: 'Who takes the call (the business name when no host is assigned)',
  site_name: 'The site’s name',
  meeting_link: 'The meeting link from the Booking page tab (empty when there is none)',
  meeting_details: '“Join the call here: …” with the link, or that details will follow',
  booking_link: 'The booking page, to book another call',
} as const;

export type SalesCallField = keyof typeof SALES_CALL_FIELDS;
export type Fields = Record<SalesCallField, string>;

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Placeholders a text uses that are not fields. */
export function unknownFields(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((f) => !(f in SALES_CALL_FIELDS)))];
}

export function assertKnownFields(...texts: string[]) {
  const unknown = [...new Set(texts.flatMap(unknownFields))];
  if (unknown.length) {
    throw new BadRequestException(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}`);
  }
}

/** Fills the placeholders in; a subject stays on one line. */
export function render(text: string, fields: Fields, oneLine = false): string {
  const out = text.replace(PLACEHOLDER, (all, f: string) => (f in fields ? fields[f as SalesCallField] : all));
  return oneLine ? out.replace(/\s*\n\s*/g, ' ').trim() : out;
}

const subject = z.string().trim().min(1).max(200);
const body = z.string().trim().min(1).max(10_000);

export const templateUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80), subject, body, sort_order: z.number().int().min(0).max(10_000) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const templateCreateSchema = z.object({ name: z.string().trim().min(1).max(80), subject, body }).strict();
export const previewSchema = z.object({ subject, body, call_id: z.string().uuid().optional() }).strict();
export const thankYouSchema = z.object({ template_id: z.string().uuid().optional(), subject, body }).strict();

export type TemplateUpdate = z.infer<typeof templateUpdateSchema>;
export type TemplateCreate = z.infer<typeof templateCreateSchema>;
export type Preview = z.infer<typeof previewSchema>;
export type ThankYou = z.infer<typeof thankYouSchema>;
