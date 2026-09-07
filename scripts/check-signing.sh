#!/usr/bin/env bash
# Is this Mac ready to sign and notarise a release?
#
#   bash scripts/check-signing.sh
#
# Checks only. It reads your keychain for the presence of a certificate and never prints, exports
# or transmits any key material. Run it after creating the Developer ID certificate to confirm the
# pieces are actually in place, rather than discovering a missing one halfway through a release.
set -uo pipefail
GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; OFF=$'\033[0m'
[ -t 1 ] || { GRN=""; RED=""; YEL=""; OFF=""; }
ok(){ printf "  ${GRN}[ok]${OFF}    %s\n" "$*"; }
no(){ printf "  ${RED}[--]${OFF}    %s\n" "$*"; }
note(){ printf "  ${YEL}[..]${OFF}    %s\n" "$*"; }
READY=1

printf "\nSigning readiness\n\n"

# 1. The certificate. "Developer ID Application" is the only kind that works for software
#    distributed outside the App Store — an "Apple Development" cert will sign but will NOT pass
#    notarisation, which is the failure that wastes an afternoon.
CERTS="$(security find-identity -v -p codesigning 2>/dev/null)"
if printf '%s' "$CERTS" | grep -q "Developer ID Application"; then
  ok "Developer ID Application certificate: $(printf '%s' "$CERTS" | grep -o '"Developer ID Application[^"]*"' | head -1)"
elif printf '%s' "$CERTS" | grep -q "Apple Development"; then
  no "Only an 'Apple Development' certificate is installed. That one cannot notarise."
  note "Create a Developer ID Application certificate at developer.apple.com/account/resources/certificates"
  READY=0
else
  no "No code-signing certificate found in the keychain."
  note "Create a Developer ID Application certificate, download the .cer, and double-click it."
  READY=0
fi

# 2. The tools.
for t in codesign stapler; do
  command -v "$t" >/dev/null 2>&1 && ok "$t" || { no "$t missing"; READY=0; }
done
if xcrun --find notarytool >/dev/null 2>&1; then ok "notarytool"; else
  no "notarytool missing — run: xcode-select --install"; READY=0
fi

# 3. The notarisation credential. Stored in the keychain by name so no secret ever lives in the
#    repo, in an environment variable, or in a shell history.
if xcrun notarytool history --keychain-profile jobseeker-notary >/dev/null 2>&1; then
  ok "notarytool keychain profile 'jobseeker-notary' works"
else
  no "No working notarytool profile named 'jobseeker-notary'."
  note "Store one once, with the App Store Connect API key you downloaded:"
  note "  xcrun notarytool store-credentials jobseeker-notary \\"
  note "    --key ~/private_keys/AuthKey_XXXXXXXX.p8 --key-id XXXXXXXX --issuer <issuer-uuid>"
  READY=0
fi

printf "\n"
[ "$READY" = 1 ] && printf "  ${GRN}Ready to sign.${OFF}\n\n" || printf "  ${YEL}Not ready yet — see the items above.${OFF}\n\n"
exit 0
