// Travel (CDS endpoint, `/cds/graphql`). Trimmed from the bundle texts in
// docs/api/travel-operations.graphql (operation names kept, fragments inlined,
// only the fields the tools return). Booking / search / hold / confirm / cancel
// operations are deliberately NOT here.

/** `loadTripList` — one page of the signed-in traveler's trips. */
export const LIST_TRIPS = `query loadTripList($filter: TravelTripListFilterInput, $sort: TravelTripListSortInput, $nextToken: String) {
  travel {
    trips {
      list(filter: $filter, sort: $sort, nextToken: $nextToken) {
        ... on TravelTripListSuccessResult {
          meta {
            nextToken
            filter {
              quick { value isSelected }
              tripName
              tripStatus { value isSelected }
              fromDate
              toDate
            }
          }
          trips {
            id
            recordLocator
            status
            displayStatus
            name
            bookings { type }
            startDate
            endDate
            approval { status }
            messagesV2 {
              gqlType: __typename
              ... on TravelTripListUntranslatedMessage { type fields { key value } }
              ... on TravelTripListTranslatedMessage { message }
            }
          }
        }
        ... on TravelErrorResponse {
          messages { code type }
        }
      }
    }
  }
}`;

/** `loadOverviewTrip` — one trip: header, cost, and each booking's essentials. */
export const GET_TRIP = `query loadOverviewTrip($tripId: ID!) {
  travel {
    trips {
      trip(id: $tripId) {
        id
        recordLocator
        name
        description
        displayStatus
        status
        localStartDate
        localEndDate
        traveler { id displayName contactDetails { type value } }
        arranger { displayName }
        agencyDetails { name }
        totalCostAmount { amount currencyCode }
        bookingsV2 {
          id
          status
          type: __typename
          ... on TravelTripAirBookingV2 {
            airBooking: booking {
              confirmationNumber
              status: statusV2
              journeys {
                originDisplayName
                destinationDisplayName
                departureDateTime
                arrivalDateTime
                nonstop
                stopsCount
                confirmationNumbers
                marketingCarrier { name iataCode }
                segments {
                  flightNumber
                  origin { iataCode name }
                  destination { iataCode name }
                  departureDateTime
                  arrivalDateTime
                  marketingCarrier { name iataCode }
                  selectedSeat { rowNumber columnLetter }
                }
              }
            }
          }
          ... on TravelTripCarBookingV2 {
            carBooking: booking {
              bookingData {
                status
                confirmationNumber
                pickupLocationDateTime {
                  localDateTime
                  location { address { address1 localityName administrativeAreaName postalCode country } }
                }
                dropoffLocationDateTime {
                  localDateTime
                  location { address { address1 localityName administrativeAreaName postalCode country } }
                }
                vendor { name }
                vehicle { category type makeModel }
              }
              totalCostItemized { currencyCode estimatedTotalAmount }
            }
          }
          ... on TravelTripHotelBookingV2 {
            hotelBooking: booking {
              bookingData {
                checkInDate
                checkOutDate
                nightCount
                roomCount
                confirmationNumber
                hotelConfirmationNumber
                status: bookingStatus
                hotel {
                  name
                  address { address1 address2 localityName administrativeAreaName postalCode }
                  contactDetails { type value }
                }
              }
              totalCost { total currencyCode }
            }
          }
          ... on TravelTripRailBookingV2 {
            railBooking: booking {
              bookingStatus
              journeys {
                departure { stationName localDateTime }
                arrival { stationName localDateTime }
                carrier { displayName }
              }
              totalCost { totalAmount currencyCode }
            }
          }
        }
        customFields { id title value }
        messages { code type }
      }
    }
  }
}`;

/** `loadTripHistory` — the trip's audit events (bookings, approvals, emails). */
export const GET_TRIP_HISTORY = `query loadTripHistory($tripId: ID!) {
  travel {
    trips {
      trip(id: $tripId) {
        id
        historyRecords {
          date
          events {
            id
            datetime
            actor { displayName }
            reason
            action {
              ... on TravelTripHistoryTripConfirmAction { type: __typename confirmDate }
              ... on TravelTripHistoryTripConfirmEmailAction { type: __typename sendDate recipients { email } }
              ... on TravelTripHistoryTripCancelAction { type: __typename cancelDate status }
              ... on TravelTripHistoryTripCreateAction { type: __typename createDate }
              ... on TravelTripHistoryPnrCancelAction { type: __typename cancelationType }
              ... on TravelTripHistoryTripApproveAction { type: __typename approver { displayName } }
              ... on TravelTripHistoryTripRejectAction { type: __typename approver { displayName } comment }
              ... on TravelTripHistoryTripSubmitForApprovalAction { type: __typename approver { displayName } deadline }
              ... on TravelTripHistoryBookingCreateAction {
                type: __typename
                bookingType
                status
                supplierDisplayName
                confirmationNumber
              }
              ... on TravelTripHistoryBookingUpdateAction { type: __typename bookingType supplierDisplayName }
              ... on TravelTripHistoryBookingCancelAction {
                type: __typename
                bookingType
                cancelationNumber
                status
                supplierDisplayName
              }
              ... on TravelTripHistoryBookingDeleteAction { type: __typename bookingType status supplierDisplayName }
              ... on TravelTripHistoryBookingChangeAction {
                type: __typename
                confirmationNumber
                status
                bookingType
                supplierDisplayName
              }
              ... on TravelTripHistoryTripChangeAction { type: __typename status }
            }
          }
        }
      }
    }
  }
}`;

/** `sendItinerary` — emails the trip's itinerary to the given addresses. */
export const SEND_ITINERARY = `mutation sendItinerary($input: TravelTripSendItineraryEmailInput!) {
  travel {
    trip {
      sendItineraryEmail(input: $input) {
        tripId
      }
    }
  }
}`;
