const { listInstalledSkills, installSkill, uninstallSkill } = require('../../v2/services/skillRuntime');

async function listSkills(_request, reply) {
  const skills = await listInstalledSkills();
  reply.send({ items: skills, count: skills.length });
}

async function installSkillHandler(request, reply) {
  try {
    const skill = await installSkill(request.body || {}, request.ctx);
    reply.code(201).send({ success: true, skill });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
}

async function deleteSkillHandler(request, reply) {
  const name = String(request.params?.name || '').trim();
  if (!name) {
    reply.code(400).send({ error: 'name is required' });
    return;
  }
  const ok = await uninstallSkill(name, request.ctx);
  if (!ok) {
    reply.code(404).send({ error: 'skill not found' });
    return;
  }
  reply.send({ success: true });
}

module.exports = {
  listSkills,
  installSkillHandler,
  deleteSkillHandler
};
