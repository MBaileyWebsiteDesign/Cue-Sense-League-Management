# Top Spin website: built from build/build.mjs, served by nginx on Fly.io.
# Images that the pages still reference on the old Wix media library are
# downloaded here at build time (build/localise-images.mjs) and served from
# /media, so visitors never load anything from Wix. The build fails if any
# Wix image could not be copied.
FROM node:22-alpine AS build
WORKDIR /app
COPY build ./build
COPY site ./site
COPY media ./media
ARG SITE_URL=https://topspin-website.fly.dev
ARG STAGING=1
ENV SITE_URL=$SITE_URL STAGING=$STAGING
RUN node build/build.mjs \
 && node build/localise-images.mjs \
 && node build/build.mjs \
 && if grep -rq "static.wixstatic.com" site; then echo "Wix images still referenced" && exit 1; fi

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/site /usr/share/nginx/html
EXPOSE 8080
