const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(process.cwd(), 'tools', 'schedule.js'), 'utf8');

const endpoints = new Set();

// Find /apis/... and /curriculum/... patterns
const re = /(?:"|')(?:(https?:)?\/\/[^"']+|)(\/apis\/[a-zA-Z0-9_\-\/\.=?&%]+|\/curriculum\/[a-zA-Z0-9_\-\/\.=?&%]+|\/pc\/curriculum\/[a-zA-Z0-9_\-\/\.=?&%]+)"/g;
let m;
while ((m = re.exec(js)) !== null) {
  const match = m[1] ? m[0] : m[2] || m[1];
  if (match) endpoints.add(match.replace(/"$/, '').replace(/'/, ''));
}

// Also find string tokens like 'getAllLessons', 'getMyLessons', 'getOtherLessons'
['getAllLessons','getMyLessons','getOtherLessons','getMeetInfo','getZhiboktStatus','getFormAddOrEditUrl','getLocationConfig','copyCurriculum'].forEach(k => endpoints.add(k));

fs.writeFileSync(path.join(process.cwd(), 'tools', 'chaoxing-xhr-endpoints.txt'), Array.from(endpoints).join('\n'));
console.log('Wrote tools/chaoxing-xhr-endpoints.txt');
