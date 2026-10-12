# Enterprise Brain chat 11.11.1-eb1: our own Mattermost build (D48) from https://github.com/tintin222/enterprise-brain-chat,
# branch enterprise-brain/v11.11.1, release eb-v11.11.1-1 (built from commit 549e445): no user limit, Enterprise Brain
# branding, no Enterprise upgrade or trial offers. The pinned Team Edition image of the same version with its server
# binary, web app and server strings replaced by the release's files, each checked against the SHA-512 sums the release
# workflow published. The image has no shell, so the new web app is copied over the old one; the old bundle files stay
# unused because root.html loads the new ones.
FROM alpine:3.22.6@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS download
ARG RELEASE=eb-v11.11.1-1
ARG SERVER_SHA512=c5683c8f968c97912ab272266889f0f5ed5cff733a585981997f0ee51d32791fc4905e7b10f4e479964689848774e28508439bf130aa85ed5c09d5d5374d6569
ARG CLIENT_SHA512=0a10aacc09d95f6bd5518fd99b3ab05b7d368cd942f002df366e07a73ad9ca602280b40fa2e82b6fee724c4917532fd67212d303c844efffc824425fc1b0bc80
ARG I18N_SHA512=12dd87a9d9a2b11c870690ce107d9e034aa6682e23103cd93eba3f5f9b7aa16948598099c7c50bb179e2aa5a646443103f729d952d7e9255ca111452077441a4
RUN base="https://github.com/tintin222/enterprise-brain-chat/releases/download/${RELEASE}" \
 && wget -q -O /server "$base/enterprise-brain-chat-server-linux-amd64" \
 && wget -q -O /client.tar.gz "$base/enterprise-brain-chat-client.tar.gz" \
 && wget -q -O /i18n.tar.gz "$base/enterprise-brain-chat-i18n.tar.gz" \
 && printf '%s  /server\n%s  /client.tar.gz\n%s  /i18n.tar.gz\n' "$SERVER_SHA512" "$CLIENT_SHA512" "$I18N_SHA512" | sha512sum -c - \
 && mkdir -p /out/client /out/root \
 && tar -xzf /client.tar.gz -C /out/client \
 && tar -xzf /i18n.tar.gz -C /out/root

FROM mattermost/mattermost-team-edition:11.11.1@sha256:6ad5912b45875ef2fafc41886b5a70a3ec1b6c17ec706e0492566e8a2fd8aa85
COPY --from=download --chown=2000:2000 --chmod=755 /server /mattermost/bin/mattermost
COPY --from=download --chown=2000:2000 /out/client/ /mattermost/client/
COPY --from=download --chown=2000:2000 /out/root/i18n/ /mattermost/i18n/
