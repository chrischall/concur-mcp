import { afterEach, describe, expect, it } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { GET_TRIP, GET_TRIP_HISTORY, LIST_TRIPS, SEND_ITINERARY } from '../src/graphql/travel.js';
import { registerTravelTools } from '../src/tools/travel.js';
import { fieldError, gqlPartial, textOf, toolHarness, untrustedPayload } from './helpers.js';

const TRIP = 'TRIP-0001';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function call(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerTravelTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  return { result, text: textOf(result), sent: t.sent, jwt: t.jwt };
}

interface Preview {
  status: string;
  confirmToken: string;
  preview: Record<string, unknown> & { action: string; willSend: Record<string, unknown> };
}

const isMutation = (q: string) => /^\s*mutation\b/.test(q);

async function confirmed(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerTravelTools, script);
  harness = t.harness;
  const first = parseToolResult<Preview>(await t.harness.callTool(name, args));
  expect(first.status).toBe('confirmation-required');
  expect(t.sent.filter((s) => isMutation(s.query))).toEqual([]);
  const phase1 = t.sent.length;
  const result = await t.harness.callTool(name, { ...args, confirmToken: first.confirmToken });
  return { preview: first, result, text: textOf(result), sent: t.sent.slice(phase1), all: t.sent };
}

// ── fixtures (shapes from docs/api/travel-operations.graphql) ─────────────

const tripRow = {
  id: TRIP,
  recordLocator: 'ABC123',
  status: 'TICKETED',
  displayStatus: 'Confirmed',
  name: 'Boston client visit',
  bookings: [{ type: 'AIR' }, { type: 'HOTEL' }, { type: 'AIR' }],
  startDate: '2026-11-02',
  endDate: '2026-11-05',
  approval: { status: 'APPROVED' },
  messagesV2: [
    { gqlType: 'TravelTripListTranslatedMessage', message: 'Your flight is ticketed' },
    { gqlType: 'TravelTripListUntranslatedMessage', type: 'TRIP_NEEDS_EXPENSE_REPORT', fields: [] },
  ],
};

const listData = (over: Record<string, unknown> = {}) => ({
  travel: {
    trips: {
      list: {
        meta: {
          nextToken: 'NEXT1',
          filter: {
            quick: [
              { value: 'UPCOMING_TRIPS', isSelected: true },
              { value: 'PAST_TRIPS', isSelected: false },
            ],
            tripName: null,
            tripStatus: [
              { value: 'CONFIRMED', isSelected: false },
              { value: 'CANCELLED', isSelected: false },
            ],
            fromDate: null,
            toDate: null,
          },
        },
        trips: [tripRow],
        ...over,
      },
    },
  },
});

const overview = (over: Record<string, unknown> = {}) => ({
  travel: {
    trips: {
      trip: {
        id: TRIP,
        recordLocator: 'ABC123',
        name: 'Boston client visit',
        description: 'Kickoff',
        displayStatus: 'Confirmed',
        status: 'TICKETED',
        localStartDate: '2026-11-02',
        localEndDate: '2026-11-05',
        traveler: { id: 'U1', displayName: 'Pat Doe', contactDetails: [{ type: 'EMAIL', value: 'pat@example.com' }] },
        arranger: null,
        agencyDetails: { name: 'Travel Co' },
        totalCostAmount: { amount: 812.4, currencyCode: 'USD' },
        bookingsV2: [
          {
            id: 'B-AIR',
            status: 'ACTIVE',
            type: 'TravelTripAirBookingV2',
            airBooking: {
              confirmationNumber: 'XYZ789',
              status: 'TICKETED',
              journeys: [
                {
                  originDisplayName: 'Charlotte',
                  destinationDisplayName: 'Boston',
                  departureDateTime: '2026-11-02T08:00',
                  arrivalDateTime: '2026-11-02T10:05',
                  nonstop: true,
                  stopsCount: 0,
                  confirmationNumbers: ['XYZ789'],
                  marketingCarrier: { name: 'American', iataCode: 'AA' },
                  segments: [
                    {
                      flightNumber: '1234',
                      origin: { iataCode: 'CLT', name: 'Charlotte Douglas' },
                      destination: { iataCode: 'BOS', name: 'Logan' },
                      departureDateTime: '2026-11-02T08:00',
                      arrivalDateTime: '2026-11-02T10:05',
                      marketingCarrier: { name: 'American', iataCode: 'AA' },
                      selectedSeat: { rowNumber: 12, columnLetter: 'C' },
                    },
                  ],
                },
              ],
            },
          },
          {
            id: 'B-HOTEL',
            status: 'ACTIVE',
            type: 'TravelTripHotelBookingV2',
            hotelBooking: {
              bookingData: {
                checkInDate: '2026-11-02',
                checkOutDate: '2026-11-05',
                nightCount: 3,
                roomCount: 1,
                confirmationNumber: 'H1',
                hotelConfirmationNumber: 'HC1',
                status: 'CONFIRMED',
                hotel: {
                  name: 'Harbor Inn',
                  address: { address1: '1 Main St', address2: null, localityName: 'Boston', administrativeAreaName: 'MA', postalCode: '02110' },
                  contactDetails: [],
                },
              },
              totalCost: { total: 600, currencyCode: 'USD' },
            },
          },
          {
            id: 'B-CAR',
            status: 'ACTIVE',
            type: 'TravelTripCarBookingV2',
            carBooking: {
              bookingData: {
                status: 'CONFIRMED',
                confirmationNumber: 'C1',
                pickupLocationDateTime: {
                  localDateTime: '2026-11-02T10:30',
                  location: { address: { address1: 'Logan Airport', localityName: 'Boston', administrativeAreaName: 'MA', postalCode: null, country: 'US' } },
                },
                dropoffLocationDateTime: { localDateTime: '2026-11-05T09:00', location: null },
                vendor: { name: 'Hertz' },
                vehicle: { category: 'COMPACT', type: 'CAR', makeModel: 'Ford Focus' },
              },
              totalCostItemized: { currencyCode: 'USD', estimatedTotalAmount: 150 },
            },
          },
          {
            id: 'B-RAIL',
            status: 'ACTIVE',
            type: 'TravelTripRailBookingV2',
            railBooking: {
              bookingStatus: 'BOOKED',
              journeys: [
                {
                  departure: { stationName: 'Boston South', localDateTime: '2026-11-04T07:00' },
                  arrival: { stationName: 'New York Penn', localDateTime: '2026-11-04T10:40' },
                  carrier: { displayName: 'Amtrak' },
                },
              ],
              totalCost: { totalAmount: 90, currencyCode: 'USD' },
            },
          },
          { id: 'B-GROUND', status: 'ACTIVE', type: 'TravelTripExtrasGroundBookingV2' },
        ],
        customFields: [{ id: 'CF1', title: 'Project', value: 'P-77' }],
        messages: [{ code: 'TRIP_TICKETED', type: 'INFO' }],
        ...over,
      },
    },
  },
});

// ── annotations ───────────────────────────────────────────────────────────

describe('travel tools', () => {
  it('registers three reads and one confirm-gated destructive write', async () => {
    const t = await toolHarness(registerTravelTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
    expect(Object.keys(byName).sort()).toEqual(
      ['concur_get_trip', 'concur_get_trip_history', 'concur_list_trips', 'concur_send_itinerary'].sort(),
    );
    for (const name of ['concur_list_trips', 'concur_get_trip', 'concur_get_trip_history']) {
      expect(byName[name]!.annotations?.readOnlyHint).toBe(true);
      expect(byName[name]!.annotations?.destructiveHint).not.toBe(true);
    }
    const send = byName.concur_send_itinerary!;
    expect(send.annotations?.readOnlyHint).toBe(false);
    expect(send.annotations?.destructiveHint).toBe(true);
    expect(Object.keys((send.inputSchema as { properties: object }).properties)).toContain('confirmToken');
    expect(send.description).toMatch(/confirmToken/);
    expect(send.description).toMatch(/email/i);
  });

  it('never wraps booking, search, hold, confirm or cancel operations', async () => {
    const t = await toolHarness(registerTravelTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    for (const tool of tools) expect(tool.name).not.toMatch(/book|search|hold|confirm|cancel/);
    for (const doc of [LIST_TRIPS, GET_TRIP, GET_TRIP_HISTORY, SEND_ITINERARY]) {
      expect(doc).not.toMatch(/tryCancel|holdTrip|confirmTrip|startSearch|saveBookingSelections|commitChange/);
    }
  });
});

// ── list ──────────────────────────────────────────────────────────────────

describe('concur_list_trips', () => {
  it('lists upcoming trips on the CDS endpoint by default, sorted by start date ascending', async () => {
    const { text, sent } = await call('concur_list_trips', {}, [listData()]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://www-us2.api.concursolutions.com/cds/graphql');
    expect(sent[0]!.query).toBe(LIST_TRIPS);
    expect(sent[0]!.variables).toEqual({
      filter: { quick: ['UPCOMING_TRIPS'] },
      sort: { sortBy: 'START_DATE', direction: 'ASCENDING' },
      nextToken: null,
    });
    expect(untrustedPayload(text)).toEqual({
      trips: [
        {
          tripId: TRIP,
          name: 'Boston client visit',
          recordLocator: 'ABC123',
          status: 'Confirmed',
          startDate: '2026-11-02',
          endDate: '2026-11-05',
          bookings: ['AIR', 'HOTEL'],
          approval: 'APPROVED',
          messages: ['Your flight is ticketed', 'TRIP_NEEDS_EXPENSE_REPORT'],
        },
      ],
      nextToken: 'NEXT1',
      availableStatuses: ['CONFIRMED', 'CANCELLED'],
    });
  });

  it('passes every filter, the sort and the paging token through', async () => {
    const { sent } = await call(
      'concur_list_trips',
      {
        when: 'past',
        name: 'Boston',
        statuses: ['CANCELLED'],
        from: '2026-01-01',
        to: '2026-06-30',
        sortBy: 'END_DATE',
        direction: 'DESCENDING',
        nextToken: 'TOK',
      },
      [listData()],
    );
    expect(sent[0]!.variables).toEqual({
      filter: { quick: ['PAST_TRIPS'], tripName: 'Boston', tripStatus: ['CANCELLED'], fromDate: '2026-01-01', toDate: '2026-06-30' },
      sort: { sortBy: 'END_DATE', direction: 'DESCENDING' },
      nextToken: 'TOK',
    });
  });

  it('omits the quick filter for when=all', async () => {
    const { sent } = await call('concur_list_trips', { when: 'all' }, [listData()]);
    expect(sent[0]!.variables.filter).toEqual({});
  });

  it('refuses a half-open date range before calling Concur', async () => {
    const { result, sent } = await call('concur_list_trips', { from: '2026-01-01' }, []);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('both `from` and `to`');
    expect(sent).toEqual([]);
  });

  it('surfaces a TravelErrorResponse as an error with its codes', async () => {
    const { result } = await call('concur_list_trips', {}, [
      { travel: { trips: { list: { messages: [{ code: 'tripList.unavailable', type: 'ERROR' }] } } } },
    ]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('tripList.unavailable');
  });

  it('answers an empty page without a token', async () => {
    const { text } = await call('concur_list_trips', {}, [listData({ trips: null, meta: { nextToken: null, filter: null } })]);
    expect(untrustedPayload(text)).toEqual({ trips: [] });
  });

  it('full view unwraps the list; raw keeps the envelope', async () => {
    const full = await call('concur_list_trips', { view: 'full' }, [listData()]);
    expect(untrustedPayload(full.text)).toMatchObject({ meta: { nextToken: 'NEXT1' }, trips: [tripRow] });
    await harness?.close();
    const raw = await call('concur_list_trips', { view: 'raw' }, [listData()]);
    expect(raw.text).toContain('"travel"');
  });
});

// ── get ───────────────────────────────────────────────────────────────────

describe('concur_get_trip', () => {
  it('reads the overview and flattens each booking', async () => {
    const { text, sent } = await call('concur_get_trip', { tripId: TRIP }, [overview()]);
    expect(sent[0]!.url).toMatch(/\/cds\/graphql$/);
    expect(sent[0]!.query).toBe(GET_TRIP);
    expect(sent[0]!.variables).toEqual({ tripId: TRIP });
    expect(untrustedPayload(text)).toEqual({
      trip: {
        tripId: TRIP,
        name: 'Boston client visit',
        description: 'Kickoff',
        recordLocator: 'ABC123',
        status: 'Confirmed',
        startDate: '2026-11-02',
        endDate: '2026-11-05',
        traveler: 'Pat Doe',
        agency: 'Travel Co',
        totalCost: '812.4 USD',
      },
      bookings: [
        {
          kind: 'air',
          bookingId: 'B-AIR',
          status: 'TICKETED',
          confirmationNumber: 'XYZ789',
          flights: [
            {
              flight: 'AA1234',
              from: 'CLT',
              to: 'BOS',
              departs: '2026-11-02T08:00',
              arrives: '2026-11-02T10:05',
              seat: '12C',
            },
          ],
        },
        {
          kind: 'hotel',
          bookingId: 'B-HOTEL',
          status: 'CONFIRMED',
          confirmationNumber: 'HC1',
          hotel: 'Harbor Inn',
          address: '1 Main St, Boston, MA, 02110',
          checkIn: '2026-11-02',
          checkOut: '2026-11-05',
          nights: 3,
          rooms: 1,
          total: '600 USD',
        },
        {
          kind: 'car',
          bookingId: 'B-CAR',
          status: 'CONFIRMED',
          confirmationNumber: 'C1',
          vendor: 'Hertz',
          vehicle: 'Ford Focus',
          pickup: { at: '2026-11-02T10:30', place: 'Logan Airport, Boston, MA, US' },
          dropoff: { at: '2026-11-05T09:00' },
          estimatedTotal: '150 USD',
        },
        {
          kind: 'rail',
          bookingId: 'B-RAIL',
          status: 'BOOKED',
          journeys: [
            { from: 'Boston South', to: 'New York Penn', departs: '2026-11-04T07:00', arrives: '2026-11-04T10:40', carrier: 'Amtrak' },
          ],
          total: '90 USD',
        },
        { kind: 'TravelTripExtrasGroundBookingV2', bookingId: 'B-GROUND', status: 'ACTIVE' },
      ],
      customFields: [{ title: 'Project', value: 'P-77' }],
      messages: ['TRIP_TICKETED'],
    });
  });

  it('errors on an unknown trip id', async () => {
    const { result } = await call('concur_get_trip', { tripId: 'NOPE' }, [{ travel: { trips: { trip: null } } }]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('concur_list_trips');
  });

  it('rejects a trip id with GraphQL punctuation', async () => {
    const { result, sent } = await call('concur_get_trip', { tripId: 'a"}{' }, []);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('full view returns the trip object', async () => {
    const { text } = await call('concur_get_trip', { tripId: TRIP, view: 'full' }, [overview()]);
    expect(untrustedPayload(text)).toMatchObject({ id: TRIP, bookingsV2: expect.any(Array) });
  });
});

// ── history ───────────────────────────────────────────────────────────────

describe('concur_get_trip_history', () => {
  const history = (records: unknown) => ({ travel: { trips: { trip: { id: TRIP, historyRecords: records } } } });

  it('flattens events with a short action name and its details', async () => {
    const { text, sent } = await call('concur_get_trip_history', { tripId: TRIP }, [
      history([
        {
          date: '2026-10-01',
          events: [
            {
              id: 'EV1',
              datetime: '2026-10-01T09:00:00Z',
              actor: { displayName: 'Pat Doe' },
              reason: null,
              action: { type: 'TravelTripHistoryTripCreateAction', createDate: '2026-10-01' },
            },
            {
              id: 'EV2',
              datetime: '2026-10-01T09:05:00Z',
              actor: null,
              reason: 'policy',
              action: { type: 'TravelTripHistoryTripConfirmEmailAction', sendDate: '2026-10-01', recipients: [{ email: 'pat@example.com' }] },
            },
            {
              id: 'EV3',
              datetime: '2026-10-02T10:00:00Z',
              actor: { displayName: 'Mgr' },
              reason: null,
              action: { type: 'TravelTripHistoryTripApproveAction', approver: { displayName: 'Mgr One' } },
            },
            { id: 'EV4', datetime: '2026-10-03T10:00:00Z', actor: null, reason: null, action: {} },
          ],
        },
      ]),
    ]);
    expect(sent[0]!.query).toBe(GET_TRIP_HISTORY);
    expect(sent[0]!.variables).toEqual({ tripId: TRIP });
    expect(untrustedPayload(text)).toEqual({
      tripId: TRIP,
      events: [
        { at: '2026-10-01T09:00:00Z', action: 'TripCreate', actor: 'Pat Doe', createDate: '2026-10-01' },
        { at: '2026-10-01T09:05:00Z', action: 'TripConfirmEmail', reason: 'policy', sendDate: '2026-10-01', recipients: ['pat@example.com'] },
        { at: '2026-10-02T10:00:00Z', action: 'TripApprove', actor: 'Mgr', approver: 'Mgr One' },
        { at: '2026-10-03T10:00:00Z', action: 'other' },
      ],
    });
  });

  it('errors on an unknown trip id', async () => {
    const { result } = await call('concur_get_trip_history', { tripId: 'NOPE' }, [{ travel: { trips: { trip: null } } }]);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('answers no events when the trip has none', async () => {
    const { text } = await call('concur_get_trip_history', { tripId: TRIP }, [history(null)]);
    expect(untrustedPayload(text)).toEqual({ tripId: TRIP, events: [] });
  });
});

// ── send itinerary ────────────────────────────────────────────────────────

describe('concur_send_itinerary', () => {
  const sentOk = (tripId: string | null = TRIP) => ({ travel: { trip: { sendItineraryEmail: tripId ? { tripId } : null } } });

  it('previews the recipients, then sends the exact UI input on the CDS endpoint', async () => {
    const args = { tripId: TRIP, recipients: ['a@example.com', 'b@example.com'], subject: 'My trip', message: 'See attached' };
    const { preview: p, text, sent, all } = await confirmed('concur_send_itinerary', args, [overview(), overview(), sentOk()]);
    const input = { tripId: TRIP, recipients: ['a@example.com', 'b@example.com'], subject: 'My trip', message: 'See attached' };
    expect(p.preview.action).toContain('Email the itinerary for trip "Boston client visit" to a@example.com, b@example.com');
    expect(p.preview.willSend).toEqual({ input });
    expect(all[0]!.query).toBe(GET_TRIP);
    expect(sent.map((s) => s.query)).toEqual([GET_TRIP, SEND_ITINERARY]);
    expect(sent[1]!.url).toMatch(/\/cds\/graphql$/);
    expect(sent[1]!.variables).toEqual({ input });
    expect(untrustedPayload(text)).toEqual({
      sent: true,
      tripId: TRIP,
      recipients: ['a@example.com', 'b@example.com'],
      response: { tripId: TRIP },
      observed: 'Concur accepted the itinerary email (delivery cannot be read back)',
    });
  });

  it('a send confirmed beside a sub-field error is a success carrying the warning, not a failure', async () => {
    const { result, text } = await confirmed('concur_send_itinerary', { tripId: TRIP, recipients: ['a@example.com'] }, [
      overview(),
      overview(),
      gqlPartial(sentOk(), fieldError(['travel', 'trip', 'audit'], 'corr-t')),
    ]);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(untrustedPayload(text)).toMatchObject({
      sent: true,
      tripId: TRIP,
      warnings: [{ path: 'travel.trip.audit', message: 'An error occurred', correlationId: 'corr-t' }],
    });
  });

  it('defaults the subject from the trip name and the message to empty', async () => {
    const { preview: p } = await confirmed('concur_send_itinerary', { tripId: TRIP, recipients: ['a@example.com'] }, [
      overview(),
      overview(),
      sentOk(),
    ]);
    expect(p.preview.willSend).toEqual({
      input: { tripId: TRIP, recipients: ['a@example.com'], subject: 'Itinerary: Boston client visit', message: '' },
    });
  });

  it('refuses a malformed address before calling Concur', async () => {
    const { result, sent } = await call('concur_send_itinerary', { tripId: TRIP, recipients: ['not-an-email'] }, []);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('refuses a subject over 150 characters', async () => {
    const { result } = await call('concur_send_itinerary', { tripId: TRIP, recipients: ['a@example.com'], subject: 'x'.repeat(151) }, []);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('reports an unconfirmed send', async () => {
    const { result } = await confirmed('concur_send_itinerary', { tripId: TRIP, recipients: ['a@example.com'] }, [
      overview(),
      overview(),
      sentOk(null),
    ]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('did not confirm');
  });

  it('errors on an unknown trip before previewing', async () => {
    const { result, sent } = await call('concur_send_itinerary', { tripId: 'NOPE', recipients: ['a@example.com'] }, [
      { travel: { trips: { trip: null } } },
    ]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(sent.filter((s) => isMutation(s.query))).toEqual([]);
  });
});

// ── sparse upstream shapes (every fallback a projection takes) ────────────

describe('sparse responses', () => {
  it('list: a missing list, and error messages without codes', async () => {
    const missing = await call('concur_list_trips', {}, [{ travel: null }]);
    expect(missing.text).toContain('no trip list');
    await harness?.close();
    const coded = await call('concur_list_trips', {}, [
      { travel: { trips: { list: { messages: [{ code: null, type: 'ERROR' }, { code: null, type: null }] } } } },
    ]);
    expect(coded.text).toContain('could not list trips: ERROR, unknown.');
  });

  it('list: rows with nulls fall back field by field', async () => {
    const { text } = await call('concur_list_trips', {}, [
      listData({
        meta: { nextToken: null, filter: { tripStatus: [{ value: null, isSelected: false }] } },
        trips: [
          {
            id: 'T2',
            status: 'HELD',
            displayStatus: null,
            bookings: [{ type: null }],
            approval: null,
            messagesV2: [{ gqlType: 'TravelTripListTranslatedMessage', message: null, type: null }],
          },
          { id: 'T3', displayStatus: '' },
        ],
      }),
    ]);
    expect(untrustedPayload(text)).toEqual({ trips: [{ tripId: 'T2', status: 'HELD' }, { tripId: 'T3' }] });
  });

  it('trip: a missing envelope, and bookings with nothing but ids', async () => {
    const missing = await call('concur_get_trip', { tripId: TRIP }, [{ travel: null }]);
    expect((missing.result as { isError?: boolean }).isError).toBe(true);
    await harness?.close();
    const { text } = await call('concur_get_trip', { tripId: TRIP }, [
      overview({
        displayStatus: null,
        totalCostAmount: { amount: 5, currencyCode: null },
        traveler: null,
        arranger: { displayName: 'Assistant' },
        agencyDetails: null,
        customFields: null,
        messages: [{ code: null }],
        bookingsV2: [
          {
            id: 'A1',
            status: 'ACTIVE',
            type: 'TravelTripAirBookingV2',
            airBooking: {
              journeys: [
                {
                  segments: [
                    { flightNumber: '9', marketingCarrier: null, selectedSeat: { rowNumber: 3, columnLetter: null } },
                    { flightNumber: null, selectedSeat: null },
                  ],
                },
                { segments: null },
              ],
            },
          },
          { id: 'A2', status: 'ACTIVE', type: 'TravelTripAirBookingV2', airBooking: { journeys: null } },
          { id: 'H1', status: 'ACTIVE', type: 'TravelTripHotelBookingV2', hotelBooking: { bookingData: null, totalCost: null } },
          {
            id: 'H2',
            type: 'TravelTripHotelBookingV2',
            hotelBooking: { bookingData: { confirmationNumber: 'CN', hotel: { name: 'Inn', address: null } }, totalCost: { total: null } },
          },
          { id: 'C1', status: 'ACTIVE', type: 'TravelTripCarBookingV2', carBooking: { bookingData: null, totalCostItemized: null } },
          {
            id: 'C2',
            type: 'TravelTripCarBookingV2',
            carBooking: {
              bookingData: { vehicle: { category: 'SUV', makeModel: null }, pickupLocationDateTime: { localDateTime: 'T', location: null } },
            },
          },
          { id: 'R1', status: 'ACTIVE', type: 'TravelTripRailBookingV2', railBooking: { journeys: null, totalCost: null } },
          { id: 'R2', type: 'TravelTripRailBookingV2', railBooking: { bookingStatus: 'X', journeys: [{}] } },
        ],
      }),
    ]);
    expect(untrustedPayload(text)).toEqual({
      trip: {
        tripId: TRIP,
        name: 'Boston client visit',
        description: 'Kickoff',
        recordLocator: 'ABC123',
        status: 'TICKETED',
        startDate: '2026-11-02',
        endDate: '2026-11-05',
        arranger: 'Assistant',
        totalCost: '5',
      },
      bookings: [
        { kind: 'air', bookingId: 'A1', status: 'ACTIVE', flights: [{ flight: '9', seat: '3' }, {}] },
        { kind: 'air', bookingId: 'A2', status: 'ACTIVE', flights: [] },
        { kind: 'hotel', bookingId: 'H1', status: 'ACTIVE' },
        { kind: 'hotel', bookingId: 'H2', confirmationNumber: 'CN', hotel: 'Inn' },
        { kind: 'car', bookingId: 'C1', status: 'ACTIVE' },
        { kind: 'car', bookingId: 'C2', vehicle: 'SUV', pickup: { at: 'T' } },
        { kind: 'rail', bookingId: 'R1', status: 'ACTIVE', journeys: [] },
        { kind: 'rail', bookingId: 'R2', status: 'X', journeys: [{}] },
      ],
    });
  });

  it('trip: no bookings at all', async () => {
    const { text } = await call('concur_get_trip', { tripId: TRIP }, [overview({ bookingsV2: null, messages: null })]);
    expect(untrustedPayload(text)).toMatchObject({ bookings: [] });
  });

  it('history: a missing envelope, null events and odd action shapes', async () => {
    const missing = await call('concur_get_trip_history', { tripId: TRIP }, [{ travel: null }]);
    expect((missing.result as { isError?: boolean }).isError).toBe(true);
    await harness?.close();
    const { text } = await call('concur_get_trip_history', { tripId: TRIP }, [
      {
        travel: {
          trips: {
            trip: {
              id: TRIP,
              historyRecords: [
                { date: '2026-10-01', events: null },
                {
                  date: '2026-10-02',
                  events: [
                    { id: 'E1', datetime: 'D1', actor: null, reason: null, action: null },
                    {
                      id: 'E2',
                      datetime: 'D2',
                      action: {
                        type: 'TravelTripHistoryAction',
                        approver: { displayName: null },
                        recipients: [{ email: null }, { email: 'x@example.com' }],
                        manager: { email: 'm@example.com' },
                        tags: ['a'],
                      },
                    },
                    { id: 'E3', datetime: 'D3', action: { type: '', recipients: 'n/a' } },
                  ],
                },
              ],
            },
          },
        },
      },
    ]);
    expect(untrustedPayload(text)).toEqual({
      tripId: TRIP,
      events: [
        { at: 'D1', action: 'other' },
        {
          at: 'D2',
          action: 'TravelTripHistoryAction',
          recipients: ['x@example.com'],
          manager: { email: 'm@example.com' },
          tags: ['a'],
        },
        { at: 'D3', action: 'other', recipients: 'n/a' },
      ],
    });
  });

  it('send: an unnamed trip uses its id, and a missing mutation envelope is unconfirmed', async () => {
    const unnamed = overview({ name: null });
    const { preview: p, result } = await confirmed('concur_send_itinerary', { tripId: TRIP, recipients: ['a@example.com'] }, [
      unnamed,
      unnamed,
      { travel: null },
    ]);
    expect(p.preview.action).toContain(`trip "${TRIP}"`);
    expect((p.preview.willSend.input as { subject: string }).subject).toBe(`Itinerary: ${TRIP}`);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
