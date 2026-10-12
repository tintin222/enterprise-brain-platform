# Enterprise Brain chat 11.7.12-eb1: our own Mattermost build (D48) from https://github.com/tintin222/enterprise-brain-chat,
# branch enterprise-brain/v11.7.12, release eb-v11.7.12-1 (built from commit 202705e): no user limit and Enterprise Brain
# branding. The pinned Team Edition image with its server binary, web app and server strings replaced by the release's
# files, each checked against the SHA-512 sums the release workflow published. The image has no shell, so the new web
# app is copied over the old one; the old bundle files stay unused because root.html loads the new ones.
FROM alpine:3.22.6@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS download
ARG RELEASE=eb-v11.7.12-1
ARG SERVER_SHA512=ee0d2beb7084c4389a0948ff92d6c4e7eddeebbb9e675be71d6e343b2c8340495f40646c91bca1005cc55bbfe66f138bbb1838fed8d57f648f706ae44ba78c56
ARG CLIENT_SHA512=5274115121ce6e0b8ec47835b2844795a9b9ad3a3d99610a5b0a61f44a5c3f280781c92785ed3303d252b0890c44bd1d6c6c48b2bbf1fceb9fad432cee8803a2
ARG I18N_SHA512=3c81e941d7eae5e7ef95992c1554fb6d72130aa8cfbe62620298cef632b1a7b211cdf0c6f0268cf3e1dbdc5d0484226f6e6f81ba153faa61609661cc646fae85
RUN base="https://github.com/tintin222/enterprise-brain-chat/releases/download/${RELEASE}" \
 && wget -q -O /server "$base/enterprise-brain-chat-server-linux-amd64" \
 && wget -q -O /client.tar.gz "$base/enterprise-brain-chat-client.tar.gz" \
 && wget -q -O /i18n.tar.gz "$base/enterprise-brain-chat-i18n.tar.gz" \
 && printf '%s  /server\n%s  /client.tar.gz\n%s  /i18n.tar.gz\n' "$SERVER_SHA512" "$CLIENT_SHA512" "$I18N_SHA512" | sha512sum -c - \
 && mkdir -p /out/client /out/root \
 && tar -xzf /client.tar.gz -C /out/client \
 && tar -xzf /i18n.tar.gz -C /out/root

FROM mattermost/mattermost-team-edition:11.7.12@sha256:618956b80399873f5c404d5dfc21ef07c3bad1169d603108a7a14cb932af5de7
COPY --from=download --chown=2000:2000 --chmod=755 /server /mattermost/bin/mattermost
COPY --from=download --chown=2000:2000 /out/client/ /mattermost/client/
COPY --from=download --chown=2000:2000 /out/root/i18n/ /mattermost/i18n/
