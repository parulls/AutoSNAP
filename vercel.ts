// A single repository, with explicitly different frontend/backend deployments.
export const config=process.env.AUTOSNAP_DEPLOYMENT_ROLE==="api"?{
  framework:"express",
  buildCommand:"npm run build:backend",
  regions:["sin1"],
  functions:{"server.ts":{
    maxDuration:300,
    includeFiles:"{app/scenario-catalog.json,node_modules/@sparticuz/chromium/bin/**,node_modules/pdfkit/js/data/**}",
  }},
}:{framework:"nextjs",buildCommand:"npm run build",regions:["sin1"]};
