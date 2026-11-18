export type HitOutcome="PASSED"|"FAILED"|"NOT_EVALUATED"|"CANCELLED"|"SUCCESS"|"SNAP_BUSINESS_ERROR"|"HTTP_ERROR"|"TRANSPORT_ERROR"|"NETWORK_ERROR"|"TIMEOUT"|"AUTH_ERROR"|"VALIDATION_ERROR"|"AUTH_SESSION_EXPIRED"|"AUTH_INTERACTION_REQUIRED"|"PRECONDITION_FAILED"|"FORM_NOT_READY"|"FORM_FIELD_NOT_FOUND"|"FORM_FIELD_DISABLED"|"AUTOMATION_ERROR"|"ASPI_SESSION_BUSY"|"ACTIVITY_NOT_FOUND"|"PDF_DOWNLOAD_ERROR"|"DATABASE_ERROR";

export class AspiAutomationError extends Error{
  constructor(public readonly outcome:HitOutcome,message:string,public readonly diagnostic:Record<string,unknown>={}){super(message);this.name="AspiAutomationError";}
}
