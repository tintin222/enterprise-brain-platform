# Enterprise Brain chat 11.7.12-eb2: our own Mattermost build (D48) from https://github.com/tintin222/enterprise-brain-chat,
# branch enterprise-brain/v11.7.12, release eb-v11.7.12-2 (built from commit 14d3de7): no user limit and Enterprise Brain
# branding. The pinned Team Edition image with its server binary, web app and server strings replaced by the release's
# files, each checked against the SHA-512 sums the release workflow published. The image has no shell, so the new web
# app is copied over the old one; the old bundle files stay unused because root.html loads the new ones.
FROM alpine:3.22.6@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS download
ARG RELEASE=eb-v11.7.12-2
ARG SERVER_SHA512=869f8d58784b1ae2880e02ba7cfc5452074a2994d0acb9b989649ebffff1fb6dcdd835fbf18069014497df6cd181fb02057e382ea35f23f20b9bf75542f3a657
ARG CLIENT_SHA512=135d14ce1cdb9156f414b1f9165e269ac7e465efefebbd80b75f9ae8e13838dfa8109942d93bfab75b2439ddee094fa51a3b855613207df21394266f40d6c9d9
ARG I18N_SHA512=1022e2db91bc955641b538e6384cc107abe6d06906344bf1aaccc1973baff929525a90dd7e4d950e2760d965414da07a8e79172a9251704d199de53ec62fd65e
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
