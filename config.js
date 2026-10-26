// Where the dashboard finds its data server (the Cloudflare Worker in worker/).
// After `npx wrangler deploy`, paste the URL it prints, followed by /api, e.g.
//   apiBase: 'https://local-emergency-alerts.YOUR-SUBDOMAIN.workers.dev/api'
// Until this is set, the page still shows official NWS alerts and wind,
// fetched straight from weather.gov, but not the industrial or fire feeds.
window.LEA_CONFIG = {
    apiBase: '',
};
