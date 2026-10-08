// Receipt documents, trimmed from the bundle texts in
// docs/api/spend-operations.graphql (GetAvailableReceipts, GetLineItemImage,
// AttachImage, AppendImage, DetachImage, DeleteReceipt). Only the fields the
// receipt tools return are selected; the e-bunsho (Japanese e-document)
// timestamp block is dropped.

/** The receipt fields every receipt read returns (a selection body, not a document). */
export const RECEIPT_FIELDS = `
  imageId
  receiptId
  fileType
  imageDate
  fileName
  imageOrigin
  imageUrl
  thumbUrl
  receiptDigitizationStatus
  complianceCountryCode
  complianceType
`;

const RECEIPT_META = `
  isEbunshoReceipt
  canAppendReceipt
  canDetachReceipt
  canReplaceReceipt
  canDownloadReceipt
  canDeleteReceipt
  isAllowedForMultipleUse
`;

/** GetAvailableReceipts — the receipt store (images not attached to an expense). */
export const LIST_AVAILABLE_RECEIPTS = `
query GetAvailableReceipts($userId: String!, $contextRole: ContextRoleType!) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    availableReceipts {
      ${RECEIPT_FIELDS}
      meta { ${RECEIPT_META} }
    }
  }
}`;

/** GetLineItemImage — one receipt image by id, with its (short-lived) `imageUrl`. */
export const GET_RECEIPT = `
query GetLineItemImage(
  $userId: String!
  $contextRole: ContextRoleType!
  $imageId: String!
  $reportId: String = null
) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    lineItemImage(imageId: $imageId) {
      ${RECEIPT_FIELDS}
      meta(reportId: $reportId) { ${RECEIPT_META} }
    }
  }
}`;

const entryImageMutation = (operation: string, field: string, withImage: boolean) => `
mutation ${operation}(
  $userId: String!
  $contextRole: ContextRoleType!
  $reportId: String!
  $expenseId: String!${withImage ? '\n  $imageId: String!' : ''}
) {
  employee(userId: $userId, contextRole: $contextRole) {
    expenseReport(reportId: $reportId) {
      entry(expenseId: $expenseId) {
        ${field}${withImage ? '(imageId: $imageId)' : ''} {
          id
          receiptImageId
        }
      }
    }
  }
}`;

/** AttachImage — put an uploaded / available receipt image on an expense. */
export const ATTACH_RECEIPT = entryImageMutation('AttachImage', 'attachImage', true);

/** AppendImage — add another image to an expense's existing receipt. */
export const APPEND_RECEIPT = entryImageMutation('AppendImage', 'appendImage', true);

/** DetachImage — take the receipt image off an expense. */
export const DETACH_RECEIPT = entryImageMutation('DetachImage', 'detachImage', false);

/** DeleteReceipt — permanently delete a receipt image. Answers a scalar. */
export const DELETE_RECEIPT = `
mutation DeleteReceipt($imageId: String!) {
  deleteReceipt(imageId: $imageId)
}`;
