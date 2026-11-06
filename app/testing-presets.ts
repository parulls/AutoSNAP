export const activeModules = ["Informasi Saldo", "Registrasi", "Keamanan"];

// These are editable examples from the supplied ASPI testing forms, not provider credentials.
export function requestExample(code: string): Record<string, unknown> {
  const reference = { partnerReferenceNo: "{{partner_reference_no}}" };
  const additionalInfo = {};
  switch (code) {
    case "11": return { ...reference, accountNo: "", balanceTypes: ["Cash", "Coins"], additionalInfo };
    case "01": return { ...reference, accountName: "", cardData: "", custIdMerchant: "", isBindAndPay: "N", merchantId: "", terminalId: "", journeyId: "", subMerchantId: "", externalStoreId: "", limit: "", merchantLogoUrl: "", phoneNo: "", sendOtpFlag: "YES", type: "", additionalInfo };
    case "02": return { ...reference, bankAccountNo: "", bankCardNo: "", limit: "", bankCardToken: "{{registration.bankCardToken}}", otp: "", additionalInfo };
    case "03": return { queryParameter: { custIdMerchant: "" } };
    case "04": return { originalPartnerReferenceNo: "", originalReferenceNo: "", action: "otpLinkage", merchantId: "", otp: "", chargeToken: "", type: "Subscribe", additionalInfo };
    case "05": return { ...reference, token: "", bankCardNo: "", type: "Unsubscribe", part: "", merchantId: "", subMerchantId: "", terminalId: "", tokenRequestorId: "", journeyId: "", transactionDate: "", additionalInfo };
    case "06": return { ...reference, countryCode: "ID", customerId: "", deviceInfo: { os: "", osVersion: "", model: "", manufacture: "" }, email: "", lang: "ID", locale: "en_ID", name: "", onboardingPartner: "", phoneNo: "", redirectUrl: "", scopes: "QUERY_BALANCE", seamlessData: "", seamlessSign: "", state: "", merchantId: "", subMerchantId: "", terminalType: "SYSTEM", additionalInfo };
    case "07": return { ...reference, action: "otpLinkage", additionalData: { userId: "", email: "", postalAddress: "" }, authCode: "{{authorization_code}}", grantType: "AUTHORIZATION_CODE", isBindAndPay: "N", lang: "ID", locale: "en_ID", merchantId: "", subMerchantId: "", msisdn: "", otp: "", phoneNo: "", platformType: "app", redirectUrl: "", referenceId: "", successParams: {}, terminalId: "", tokenRequestorId: "", additionalInfo };
    case "08": return { ...reference, additionalInfo };
    case "09": return { ...reference, linkId: "", merchantId: "", subMerchantId: "", tokenId: "", additionalInfo };
    case "10": return { queryParameter: { redirectUrl: "", scopes: "QUERY_BALANCE", state: "", merchantId: "", subMerchantId: "", lang: "ID", allowRegistration: true } };
    case "81": return { ...reference, journeyId: "", merchantId: "", subMerchant: "", externalStoreId: "", trxDateTime: "", bankCardToken: "{{registration.bankCardToken}}", otpTrxCode: "", otpReasonCode: "", otpReasonMessage: "", additionalInfo };
    case "73": return { grantType: "client_credentials", additionalInfo };
    case "74": return { grantType: "AUTHORIZATION_CODE", authCode: "{{authorization_code}}", additionalInfo };
    default: return { ...reference, additionalInfo };
  }
}

export const headerGuide = [
  ["Content-Type", "Wajib", "application/json; dibentuk backend"],
  ["Authorization", "Wajib", "Bearer token B2B dari Keamanan atau token tersimpan pada Client"],
  ["Authorization-Customer", "B2B2C", "Customer token pada User SNAP; dikirim hanya pada use case B2B2C"],
  ["X-TIMESTAMP", "Wajib", "Waktu sekarang ISO 8601 +07:00; identik dengan timestamp signature terkait"],
  ["X-SIGNATURE", "Wajib", "RSA untuk access token; HMAC-SHA512 untuk Balance Inquiry"],
  ["X-PARTNER-ID", "Wajib", "Client ID untuk profil ASPI; jangan membuat nilai acak"],
  ["X-EXTERNAL-ID", "Wajib", "Dibuat otomatis, numeric string maksimal 36 digit, unik per hari dan environment"],
  ["CHANNEL-ID", "Wajib", "CHANNEL-ID yang diberikan penyedia pada Client"],
  ["X-DEVICE-ID", "B2B2C", "Device ID pada Client"],
  ["ORIGIN", "Opsional", "Origin pada Client; berbeda dengan Base URL target"],
  ["X-IP-ADDRESS", "Opsional", "IP valid pada Client; contoh portal 172.24.281.24 bukan IP valid"],
  ["X-LATITUDE", "Opsional", "Latitude pada Client"],
  ["X-LONGITUDE", "Opsional", "Longitude pada Client"],
];
