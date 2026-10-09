// Travel (CDS endpoint): list trips, one trip's overview, a trip's history,
// and emailing its itinerary. Booking, search, hold, confirm and cancel are
// deliberately out of scope — those move real money / reservations.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  IsoDate,
  McpToolError,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  confirmTokenParam,
  confirmWrite,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { warningsField, type ConcurClient } from '../client.js';
import { GET_TRIP, GET_TRIP_HISTORY, LIST_TRIPS, SEND_ITINERARY } from '../graphql/travel.js';
import { concurView, prune, respond } from './shared.js';

const GATE = `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`;

const QUICK_FILTER = { upcoming: 'UPCOMING_TRIPS', past: 'PAST_TRIPS' } as const;
const SORT_BY = ['START_DATE', 'END_DATE', 'CREATED_TIME'] as const;
const DIRECTIONS = ['ASCENDING', 'DESCENDING'] as const;
const SUBJECT_MAX = 150; // the web app's limit

export const tripIdParam = z
  .string()
  .regex(/^[A-Za-z0-9_.:=+-]{1,200}$/, 'a Concur trip id')
  .describe('Trip id (`tripId` from concur_list_trips).');

// ── shapes ────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

interface TravelPrice {
  amount?: number | null;
  currencyCode?: string | null;
}

interface TripListRow {
  id?: string;
  recordLocator?: string | null;
  status?: string | null;
  displayStatus?: string | null;
  name?: string | null;
  bookings?: Array<{ type?: string | null }> | null;
  startDate?: string | null;
  endDate?: string | null;
  approval?: { status?: string | null } | null;
  messagesV2?: Array<{ gqlType?: string; type?: string | null; message?: string | null }> | null;
  [key: string]: unknown;
}

interface TripListResult {
  meta?: {
    nextToken?: string | null;
    filter?: { tripStatus?: Array<{ value?: string; isSelected?: boolean }> | null } | null;
  } | null;
  trips?: TripListRow[] | null;
  messages?: Array<{ code?: string | null; type?: string | null }> | null;
}

interface ListTripsData {
  travel: { trips: { list: TripListResult | null } | null } | null;
}

interface Address {
  address1?: string | null;
  address2?: string | null;
  localityName?: string | null;
  administrativeAreaName?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

interface Booking {
  id?: string;
  status?: string | null;
  type?: string;
  airBooking?: {
    confirmationNumber?: string | null;
    status?: string | null;
    journeys?: Array<{
      segments?: Array<{
        flightNumber?: string | null;
        origin?: { iataCode?: string | null } | null;
        destination?: { iataCode?: string | null } | null;
        departureDateTime?: string | null;
        arrivalDateTime?: string | null;
        marketingCarrier?: { iataCode?: string | null } | null;
        selectedSeat?: { rowNumber?: number | null; columnLetter?: string | null } | null;
      }> | null;
    }> | null;
  } | null;
  carBooking?: {
    bookingData?: {
      status?: string | null;
      confirmationNumber?: string | null;
      pickupLocationDateTime?: CarPoint | null;
      dropoffLocationDateTime?: CarPoint | null;
      vendor?: { name?: string | null } | null;
      vehicle?: { category?: string | null; makeModel?: string | null } | null;
    } | null;
    totalCostItemized?: { currencyCode?: string | null; estimatedTotalAmount?: number | null } | null;
  } | null;
  hotelBooking?: {
    bookingData?: {
      checkInDate?: string | null;
      checkOutDate?: string | null;
      nightCount?: number | null;
      roomCount?: number | null;
      confirmationNumber?: string | null;
      hotelConfirmationNumber?: string | null;
      status?: string | null;
      hotel?: { name?: string | null; address?: Address | null } | null;
    } | null;
    totalCost?: { total?: number | null; currencyCode?: string | null } | null;
  } | null;
  railBooking?: {
    bookingStatus?: string | null;
    journeys?: Array<{
      departure?: { stationName?: string | null; localDateTime?: string | null } | null;
      arrival?: { stationName?: string | null; localDateTime?: string | null } | null;
      carrier?: { displayName?: string | null } | null;
    }> | null;
    totalCost?: { totalAmount?: number | null; currencyCode?: string | null } | null;
  } | null;
}

interface CarPoint {
  localDateTime?: string | null;
  location?: { address?: Address | null } | null;
}

interface Trip {
  id?: string;
  recordLocator?: string | null;
  name?: string | null;
  description?: string | null;
  displayStatus?: string | null;
  status?: string | null;
  localStartDate?: string | null;
  localEndDate?: string | null;
  traveler?: { displayName?: string | null } | null;
  arranger?: { displayName?: string | null } | null;
  agencyDetails?: { name?: string | null } | null;
  totalCostAmount?: TravelPrice | null;
  bookingsV2?: Booking[] | null;
  customFields?: Array<{ title?: string | null; value?: string | null }> | null;
  messages?: Array<{ code?: string | null }> | null;
  [key: string]: unknown;
}

interface TripData {
  travel: { trips: { trip: Trip | null } | null } | null;
}

interface HistoryEvent {
  id?: string;
  datetime?: string | null;
  actor?: { displayName?: string | null } | null;
  reason?: string | null;
  action?: (Rec & { type?: string }) | null;
}

interface TripHistoryData {
  travel: {
    trips: {
      trip: { id?: string; historyRecords?: Array<{ date?: string; events?: HistoryEvent[] | null }> | null } | null;
    } | null;
  } | null;
}

// ── projections ───────────────────────────────────────────────────────────

const amount = (value: number | null | undefined, currency: string | null | undefined) =>
  value === null || value === undefined ? undefined : currency ? `${value} ${currency}` : String(value);

const joinAddress = (a: Address | null | undefined) => {
  const parts = [a?.address1, a?.address2, a?.localityName, a?.administrativeAreaName, a?.postalCode, a?.country].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return parts.length > 0 ? parts.join(', ') : undefined;
};

const nonEmpty = <T>(list: T[]): T[] | undefined => (list.length > 0 ? list : undefined);

function listOf(data: ListTripsData): TripListResult {
  const list = data.travel?.trips?.list;
  if (!list) throw new McpToolError('SAP Concur returned no trip list for the signed-in user.');
  if (!('trips' in list) && list.messages) {
    const codes = list.messages.map((m) => m.code ?? m.type ?? 'unknown').join(', ');
    throw new McpToolError(`SAP Concur could not list trips: ${codes}.`, {
      hint: 'Retry; if it persists, open Trips in the Concur web app.',
    });
  }
  return list;
}

function compactTripRow(t: TripListRow) {
  return prune({
    tripId: t.id,
    name: t.name,
    recordLocator: t.recordLocator,
    status: t.displayStatus || t.status,
    startDate: t.startDate,
    endDate: t.endDate,
    bookings: nonEmpty([...new Set((t.bookings ?? []).map((b) => b.type).filter((x): x is string => !!x))]),
    approval: t.approval?.status,
    messages: nonEmpty(
      (t.messagesV2 ?? []).map((m) => m.message || m.type).filter((x): x is string => typeof x === 'string' && x.length > 0),
    ),
  });
}

function compactTripList(list: TripListResult) {
  const statuses = (list.meta?.filter?.tripStatus ?? []).map((s) => s.value).filter((v): v is string => !!v);
  return prune({
    trips: (list.trips ?? []).map(compactTripRow),
    nextToken: list.meta?.nextToken,
    availableStatuses: nonEmpty(statuses),
  });
}

/** What a trip read cannot do without. */
const TRIP_ESSENTIAL = { essential: ['travel.trips.trip'] } as const;

function requireTrip(data: TripData): Trip {
  const trip = data.travel?.trips?.trip;
  if (!trip) {
    throw new McpToolError('SAP Concur returned no trip with that id for the signed-in user.', {
      hint: 'Check the id with concur_list_trips.',
    });
  }
  return trip;
}

function compactBooking(b: Booking) {
  const base = { bookingId: b.id };
  if (b.airBooking) {
    const air = b.airBooking;
    const flights = (air.journeys ?? []).flatMap((j) =>
      (j.segments ?? []).map((s) =>
        prune({
          flight: s.flightNumber ? `${s.marketingCarrier?.iataCode ?? ''}${s.flightNumber}` : undefined,
          from: s.origin?.iataCode,
          to: s.destination?.iataCode,
          departs: s.departureDateTime,
          arrives: s.arrivalDateTime,
          seat: s.selectedSeat?.rowNumber ? `${s.selectedSeat.rowNumber}${s.selectedSeat.columnLetter ?? ''}` : undefined,
        }),
      ),
    );
    return prune({ kind: 'air', ...base, status: air.status ?? b.status, confirmationNumber: air.confirmationNumber, flights });
  }
  if (b.hotelBooking) {
    const d = b.hotelBooking.bookingData ?? {};
    const total = b.hotelBooking.totalCost;
    return prune({
      kind: 'hotel',
      ...base,
      status: d.status ?? b.status,
      confirmationNumber: d.hotelConfirmationNumber || d.confirmationNumber,
      hotel: d.hotel?.name,
      address: joinAddress(d.hotel?.address),
      checkIn: d.checkInDate,
      checkOut: d.checkOutDate,
      nights: d.nightCount,
      rooms: d.roomCount,
      total: amount(total?.total, total?.currencyCode),
    });
  }
  if (b.carBooking) {
    const d = b.carBooking.bookingData ?? {};
    const point = (p: CarPoint | null | undefined) =>
      p ? prune({ at: p.localDateTime, place: joinAddress(p.location?.address) }) : undefined;
    const total = b.carBooking.totalCostItemized;
    return prune({
      kind: 'car',
      ...base,
      status: d.status ?? b.status,
      confirmationNumber: d.confirmationNumber,
      vendor: d.vendor?.name,
      vehicle: d.vehicle?.makeModel || d.vehicle?.category,
      pickup: point(d.pickupLocationDateTime),
      dropoff: point(d.dropoffLocationDateTime),
      estimatedTotal: amount(total?.estimatedTotalAmount, total?.currencyCode),
    });
  }
  if (b.railBooking) {
    const r = b.railBooking;
    return prune({
      kind: 'rail',
      ...base,
      status: r.bookingStatus ?? b.status,
      journeys: (r.journeys ?? []).map((j) =>
        prune({
          from: j.departure?.stationName,
          to: j.arrival?.stationName,
          departs: j.departure?.localDateTime,
          arrives: j.arrival?.localDateTime,
          carrier: j.carrier?.displayName,
        }),
      ),
      total: amount(r.totalCost?.totalAmount, r.totalCost?.currencyCode),
    });
  }
  return prune({ kind: b.type, ...base, status: b.status });
}

function compactTrip(data: TripData) {
  const t = requireTrip(data);
  return prune({
    trip: prune({
      tripId: t.id,
      name: t.name,
      description: t.description,
      recordLocator: t.recordLocator,
      status: t.displayStatus || t.status,
      startDate: t.localStartDate,
      endDate: t.localEndDate,
      traveler: t.traveler?.displayName,
      arranger: t.arranger?.displayName,
      agency: t.agencyDetails?.name,
      totalCost: amount(t.totalCostAmount?.amount, t.totalCostAmount?.currencyCode),
    }),
    bookings: (t.bookingsV2 ?? []).map(compactBooking),
    customFields: nonEmpty((t.customFields ?? []).map((f) => prune({ title: f.title, value: f.value }))),
    messages: nonEmpty((t.messages ?? []).map((m) => m.code).filter((c): c is string => !!c)),
  });
}

function requireHistoryTrip(data: TripHistoryData) {
  const trip = data.travel?.trips?.trip;
  if (!trip) {
    throw new McpToolError('SAP Concur returned no trip with that id for the signed-in user.', {
      hint: 'Check the id with concur_list_trips.',
    });
  }
  return trip;
}

/** `TravelTripHistoryTripApproveAction` → `TripApprove`. */
const shortAction = (type: string | undefined) =>
  type ? type.replace(/^TravelTripHistory/, '').replace(/Action$/, '') || type : 'other';

function compactDetail(key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'displayName' in value) {
    return (value as { displayName?: unknown }).displayName ?? undefined;
  }
  if (key === 'recipients' && Array.isArray(value)) {
    return value.map((r) => (r as { email?: unknown }).email).filter((e) => typeof e === 'string');
  }
  return value;
}

function compactHistory(data: TripHistoryData) {
  const trip = requireHistoryTrip(data);
  const events = (trip.historyRecords ?? []).flatMap((r) => r.events ?? []);
  return {
    tripId: trip.id,
    events: events.map((e) => {
      const { type, ...details } = e.action ?? {};
      const flat = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, compactDetail(k, v)]));
      return prune({ at: e.datetime, action: shortAction(type), actor: e.actor?.displayName, reason: e.reason, ...flat });
    }),
  };
}

// ── registration ──────────────────────────────────────────────────────────

export function registerTravelTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_list_trips',
    {
      description:
        'List your SAP Concur Travel trips (name, record locator, status, dates, booking kinds, approval). Upcoming ' +
        'by default; `when: past` or `all`, filter by trip name, status (values from `availableStatuses`) and a ' +
        'date range. Paged by `nextToken`. Use the tripId with concur_get_trip. Read-only — this MCP never books, ' +
        'changes or cancels travel. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'List Concur trips', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        when: z.enum(['upcoming', 'past', 'all']).default('upcoming').describe('Which trips (default upcoming).'),
        name: z.string().trim().min(1).max(200).optional().describe('Only trips whose name matches this text.'),
        statuses: z
          .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'a trip status value such as CONFIRMED'))
          .max(20)
          .optional()
          .describe('Only these trip statuses (values as listed in `availableStatuses`).'),
        from: IsoDate.optional().describe('Range start, YYYY-MM-DD (needs `to`).'),
        to: IsoDate.optional().describe('Range end, YYYY-MM-DD (needs `from`).'),
        sortBy: z.enum(SORT_BY).default('START_DATE').describe('Sort attribute (default START_DATE).'),
        direction: z.enum(DIRECTIONS).default('ASCENDING').describe('Sort direction (default ASCENDING).'),
        nextToken: z.string().min(1).max(4096).optional().describe('`nextToken` from the previous page.'),
        view: concurView('compact drops the filter metadata, image URLs and message fields, and dedupes booking kinds.'),
      }),
    },
    async ({ when, name, statuses, from, to, sortBy, direction, nextToken, view }) => {
      if ((from === undefined) !== (to === undefined)) {
        throw new McpToolError('Pass both `from` and `to` for a date range, or neither.');
      }
      const filter = {
        ...(when === 'all' ? {} : { quick: [QUICK_FILTER[when]] }),
        ...(name ? { tripName: name } : {}),
        ...(statuses && statuses.length > 0 ? { tripStatus: statuses } : {}),
        ...(from && to ? { fromDate: from, toDate: to } : {}),
      };
      const data = await client.cds<ListTripsData>(LIST_TRIPS, {
        filter,
        sort: { sortBy, direction },
        nextToken: nextToken ?? null,
      }, { essential: ['travel.trips.list'] });
      listOf(data); // an error result is an error, not something to project around
      return respond(
        view,
        data,
        { compact: (d) => compactTripList(listOf(d)), full: listOf },
        { context: 'loadTripList', untrusted: true },
      );
    },
  );

  server.registerTool(
    'concur_get_trip',
    {
      description:
        'Get one SAP Concur Travel trip: header (status, dates, traveler, agency, total cost) and each booking — ' +
        'flights (flight number, airports, times, seat), hotel (name, address, check-in/out, confirmation), car ' +
        '(vendor, pickup/drop-off), rail (stations, times). Read-only. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get a Concur trip', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        tripId: tripIdParam,
        view: concurView('compact flattens each booking to its essentials and joins addresses and amounts into strings.'),
      }),
    },
    async ({ tripId, view }) => {
      const data = await client.cds<TripData>(GET_TRIP, { tripId }, TRIP_ESSENTIAL);
      requireTrip(data);
      return respond(view, data, { compact: compactTrip, full: requireTrip }, { context: 'loadOverviewTrip', untrusted: true });
    },
  );

  server.registerTool(
    'concur_get_trip_history',
    {
      description:
        "Get an SAP Concur Travel trip's history: when it was created, confirmed, approved or rejected, bookings " +
        'added/changed/cancelled, and itinerary emails sent (with recipients). Read-only. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get a Concur trip history', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        tripId: tripIdParam,
        view: concurView('compact flattens every event to {at, action, actor, reason, ...details} with short action names.'),
      }),
    },
    async ({ tripId, view }) => {
      const data = await client.cds<TripHistoryData>(GET_TRIP_HISTORY, { tripId }, TRIP_ESSENTIAL);
      requireHistoryTrip(data);
      return respond(
        view,
        data,
        { compact: compactHistory, full: requireHistoryTrip },
        { context: 'loadTripHistory', untrusted: true },
      );
    },
  );

  server.registerTool(
    'concur_send_itinerary',
    {
      description:
        "Email an SAP Concur Travel trip's itinerary to one or more addresses (as the web app's \"Send itinerary\"). " +
        'This sends real email to those recipients and cannot be undone. The subject defaults to "Itinerary: <trip ' +
        'name>". ' +
        GATE,
      annotations: toolAnnotations({ title: 'Email a Concur trip itinerary', destructive: true, openWorld: true }),
      inputSchema: z.object({
        tripId: tripIdParam,
        recipients: z.array(z.email()).min(1).max(20).describe('Email addresses to send the itinerary to.'),
        subject: z.string().trim().min(1).max(SUBJECT_MAX).optional().describe(`Email subject (max ${SUBJECT_MAX} characters).`),
        message: z.string().trim().max(2000).default('').describe('Optional message included in the email.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ tripId, recipients, subject, message, confirmToken }, ctx) => {
      const trip = requireTrip(await client.cds<TripData>(GET_TRIP, { tripId }, TRIP_ESSENTIAL));
      const tripName = trip.name || tripId;
      const input = {
        tripId,
        recipients,
        subject: subject ?? `Itinerary: ${tripName}`.slice(0, SUBJECT_MAX),
        message,
      };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_send_itinerary',
        action: 'concur.trip.send_itinerary',
        summary: `Email the itinerary for trip "${tripName}" to ${recipients.join(', ')}`,
        account: await client.userId(),
        target: tripId,
        payload: { input },
        confirmToken,
      });
      if (gate) return gate;

      // A sub-field error beside the confirmation must not turn a sent email into a failure.
      const res = await client.cds<{ travel: { trip: { sendItineraryEmail: { tripId?: string } | null } | null } | null }>(
        SEND_ITINERARY,
        { input },
        { essential: ['travel.trip.sendItineraryEmail'] },
      );
      if (!res.travel?.trip?.sendItineraryEmail?.tripId) {
        throw new McpToolError('SAP Concur did not confirm sending the itinerary email; it may or may not have been sent.', {
          hint: 'Check the trip with concur_get_trip_history before sending again.',
        });
      }
      return untrustedResult({
        sent: true,
        tripId,
        recipients,
        response: res.travel.trip.sendItineraryEmail,
        ...warningsField(res),
        observed: 'Concur accepted the itinerary email (delivery cannot be read back)',
      });
    },
  );
}
