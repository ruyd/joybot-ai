import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api';
import type { Appointment } from './PortalPages';

/** A customer's appointment, with whether it is still a request staff have to confirm. */
export type CustomerAppointment = Appointment & { requested_by_customer: boolean; reviewed_at: string | null; service_id: string | null };

/** The signed-in customer's appointments (shared by the assistant rail, Appointments and Book). */
export function useMyAppointments() {
  const api = useApi();
  return useQuery({ queryKey: ['appointments', 'mine'], queryFn: () => api.get<CustomerAppointment[]>('/appointments?limit=100') });
}

/** Booked and still to come (scheduled or confirmed), soonest first. */
export function upcomingOf(list: CustomerAppointment[] | undefined): CustomerAppointment[] {
  const now = Date.now();
  return (list ?? [])
    .filter((a) => Date.parse(a.scheduled_end ?? a.scheduled_start) >= now && ['scheduled', 'confirmed'].includes(a.status))
    .sort((a, b) => Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start));
}

/** A request the team has not confirmed yet. */
export const isRequest = (a: CustomerAppointment) => a.requested_by_customer && !a.reviewed_at && a.status === 'scheduled';

export const fmtIn = (iso: string, timeZone: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { timeZone, ...opts }).format(new Date(iso));

const dayKey = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** "Today", "Tomorrow" or "Tue, Nov 17" in the appointment's time zone. */
export function dayLabel(iso: string, timeZone: string): string {
  const day = dayKey(iso, timeZone);
  if (day === dayKey(new Date().toISOString(), timeZone)) return 'Today';
  if (day === dayKey(new Date(Date.now() + 86_400_000).toISOString(), timeZone)) return 'Tomorrow';
  return fmtIn(iso, timeZone, { weekday: 'short', month: 'short', day: 'numeric' });
}

export const clockIn = (iso: string, timeZone: string) => fmtIn(iso, timeZone, { hour: 'numeric', minute: '2-digit' });

export const minutesOf = (a: Pick<Appointment, 'scheduled_start' | 'scheduled_end'>) =>
  a.scheduled_end ? Math.round((Date.parse(a.scheduled_end) - Date.parse(a.scheduled_start)) / 60_000) : null;

/** Downloads the appointment as a calendar file (.ics) the phone or mail app can add. */
export function downloadIcs(a: Appointment) {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const end = a.scheduled_end ?? new Date(Date.parse(a.scheduled_start) + 3_600_000).toISOString();
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JoyBot//Appointments//EN',
    'BEGIN:VEVENT',
    `UID:${a.id}@joybot`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(a.scheduled_start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${text(a.service_name)}`,
    `LOCATION:${text(a.location_name)}`,
    `DESCRIPTION:${text(`${a.appointment_number}${a.employee_name ? ` with ${a.employee_name}` : ''}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${a.appointment_number}.ics`;
  link.click();
  URL.revokeObjectURL(url);
}
