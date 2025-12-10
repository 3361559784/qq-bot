const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Config
const BASE_URL = process.env.BASE_URL || 'http://localhost:7071/api/ocrCourse';
const FUNCTION_KEY = process.env.FUNC_KEY || '';

async function post(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (FUNCTION_KEY) headers['x-functions-key'] = FUNCTION_KEY;
  const res = await fetch(BASE_URL, { method: 'POST', headers, body: JSON.stringify(payload)});
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) } }
  catch(e) { return { status: res.status, body: text } }
}

async function run() {
  console.log('Testing ocrCourse endpoint:', BASE_URL);

  // 1) ICS (public) test
  console.log('\n--- ICS Test');
  let resp = await post({ userId: 'testUser', fileLinks: ['https://www.calendarlabs.com/ical-calendar/ics/76/US_Holidays.ics'] });
  console.log('Status', resp.status);
  console.log(JSON.stringify(resp.body, null, 2));

  // 2) Excel test (user-provided): place a sample xlsx at a public raw URL and set as env or use sample local file upload service
  console.log('\n--- Excel Test (provide a publicly accessible Excel file URL)');
  const sampleExcelUrl = process.env.SAMPLE_EXCEL_URL || '';
  if (sampleExcelUrl) {
    resp = await post({ userId: 'testUser', fileLinks: [sampleExcelUrl] });
    console.log('Status', resp.status);
    console.log(JSON.stringify(resp.body, null, 2));
  } else {
    console.log('\tSkipping Excel test: set SAMPLE_EXCEL_URL env var to a public .xlsx URL to test.');
  }

  // 3) OCR test (image url)
  console.log('\n--- OCR Image Test');
  const sampleImageUrl = process.env.SAMPLE_IMAGE_URL || '';
  if (sampleImageUrl) {
    resp = await post({ userId: 'testUser', imageUrls: [sampleImageUrl] });
    console.log('Status', resp.status);
    console.log(JSON.stringify(resp.body, null, 2));
  } else {
    console.log('\tSkipping OCR image test: set SAMPLE_IMAGE_URL env var to a public image URL to test.');
  }

  // 4) Optional: Check Cosmos DB via query point if COSMOS_DB_STRING is present.
  if (process.env.COSMOS_DB_STRING) {
    console.log('\n--- CosmosDB check enabled (just prints a note - integration depends on DB client).');
    console.log('\tEnsure your Cosmos DB emulation/connection is configured in local.settings.json.');
  }
}

run().catch(e => { console.error('Test script error:', e); process.exit(1); });
