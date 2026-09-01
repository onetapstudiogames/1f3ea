// Full artifacts may expand to six JSON bytes per stored UTF-8 byte. Two
// maximum-size artifacts remain below the host's 4.5 MB response ceiling;
// three do not, even before the response envelope is added.
export const PURCHASE_HISTORY_PAGE_LIMIT = 2

export const STANDING_LISTINGS_PAGE_LIMIT = 50
