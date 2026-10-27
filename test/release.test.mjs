import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const script=await readFile(new URL('../release.sh',import.meta.url),'utf8');
const runBoundary=script.indexOf('# ----------------------------- run ');
assert.ok(runBoundary>0,'Release tests must not execute the state-changing run section');
const definitions=script.slice(0,runBoundary);
const hasBash=spawnSync('bash',['-c',':']).status===0;
const shellTest=(name,run)=>test(name,{skip:!hasBash&&'Bash is required for release.sh checks'},run);
async function fixture(run,{version='1.2.3',lockVersion=version,changelog='# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Correct a bug.\n\n## [1.2.3]\n\n- Previous release.\n'}={}){
  const root=await mkdtemp(join(tmpdir(),'nodecode-release-'));
  try{
    await writeFile(join(root,'package.json'),JSON.stringify({name:'fixture',version})+'\n');
    await writeFile(join(root,'package-lock.json'),JSON.stringify({name:'fixture',version:lockVersion,lockfileVersion:3,packages:{'':{name:'fixture',version:lockVersion},'node_modules/example':{version:'4.5.6'}}})+'\n');
    await writeFile(join(root,'CHANGELOG.md'),changelog);
    const shell=async body=>{
      const path=join(root,'release-functions.sh');
      await writeFile(path,definitions+'\n'+body+'\n');
      const result=spawnSync('bash',[path],{cwd:root,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr||result.stdout);
      return result.stdout;
    };
    await run({root,shell,read:name=>readFile(join(root,name),'utf8')});
  }finally{await rm(root,{recursive:true,force:true});}
}

shellTest('release promotes all Unreleased entries after subsection headings',()=>fixture(async({shell,read})=>{
  const output=await shell('apply_release_changes v1.2.4; printf "%s" "$CHANGELOG_STATUS"');
  assert.match(output,/promoted \[Unreleased\]/);
  assert.match(await read('CHANGELOG.md'),/## \[Unreleased\]\n\n## \[1\.2\.4\]\n\n### Fixed\n\n- Correct a bug\./);
}));

shellTest('release does not promote an empty Unreleased section using older release entries',()=>fixture(async({shell,read})=>{
  await shell('apply_release_changes v1.2.4');
  assert.doesNotMatch(await read('CHANGELOG.md'),/## \[1\.2\.4\]/);
},{changelog:'# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n## [1.2.3]\n\n- Previous release.\n'}));

shellTest('release version updates package and lock root metadata without changing dependencies',()=>fixture(async({shell,read})=>{
  await shell('apply_release_changes v1.2.4');
  assert.equal(JSON.parse(await read('package.json')).version,'1.2.4');
  const lock=JSON.parse(await read('package-lock.json'));
  assert.equal(lock.version,'1.2.4');
  assert.equal(lock.packages[''].version,'1.2.4');
  assert.deepEqual(lock.packages['node_modules/example'],{version:'4.5.6'});
}));

shellTest('release repairs stale lock version even when package version already matches',()=>fixture(async({shell,read})=>{
  await shell('apply_release_changes v1.2.3');
  const lock=JSON.parse(await read('package-lock.json'));
  assert.equal(lock.version,'1.2.3');
  assert.equal(lock.packages[''].version,'1.2.3');
},{lockVersion:'1.2.0'}));

shellTest('release dry run leaves package, lock and changelog unchanged',()=>fixture(async({shell,read})=>{
  const names=['package.json','package-lock.json','CHANGELOG.md'];
  const before=await Promise.all(names.map(read));
  const output=await shell('apply_release_changes v1.2.4 true; printf "%s\\n%s" "$VERSION_STATUS" "$CHANGELOG_STATUS"');
  assert.match(output,/would bump 1\.2\.3 -> 1\.2\.4/);
  assert.match(output,/would promote \[Unreleased\]/);
  assert.deepEqual(await Promise.all(names.map(read)),before);
}));

shellTest('release secret preflight finds the CI environment secret used by publish.yml',()=>fixture(async({shell})=>{
  const output=await shell(`gh(){
    case "$*" in
      *'--env CI'*) printf 'VSCE_PAT\\n' ;;
      *) printf 'OTHER_SECRET\\n' ;;
    esac
  }
  repo_secret_state`);
  assert.equal(output,'VSCE_PAT CI environment secret is set');
}));

shellTest('release secret preflight also accepts a repository PAT inherited by the publish job',()=>fixture(async({shell})=>{
  const output=await shell(`gh(){
    case "$*" in
      *'--env CI'*) printf 'OTHER_SECRET\\n' ;;
      *) printf 'VSCE_PAT\\n' ;;
    esac
  }
  repo_secret_state`);
  assert.equal(output,'VSCE_PAT repo secret is set');
}));

shellTest('release secret preflight distinguishes missing secrets from unreadable publish scopes',()=>fixture(async({shell})=>{
  assert.equal(await shell('gh(){ return 1; }; repo_secret_state'),'this run could not read all publish secret scopes');
  assert.match(await shell('gh(){ return 0; }; repo_secret_state'),/VSCE_PAT is NOT set in the CI environment or repository/);
  assert.equal(await shell(`gh(){
    case "$*" in
      *'--env CI'*) return 1 ;;
      *) printf 'VSCE_PAT\\n' ;;
    esac
  }
  repo_secret_state`),'VSCE_PAT repo secret is set');
  assert.equal(await shell(`gh(){
    case "$*" in
      *'--env CI'*) printf 'OTHER_SECRET\\n' ;;
      *) return 1 ;;
    esac
  }
  repo_secret_state`),'this run could not read all publish secret scopes');
}));

shellTest('remote-sync gate reports a mismatched branch without an unbound-variable failure',()=>fixture(async({shell})=>{
  const output=await shell(`git(){
    case "$*" in
      'rev-parse HEAD') printf 'local-sha\\n' ;;
      'rev-parse --abbrev-ref HEAD') printf 'main\\n' ;;
      'ls-remote --exit-code --heads origin main') return 0 ;;
      'ls-remote origin refs/heads/main') printf 'remote-sha refs/heads/main\\n' ;;
    esac
  }
  DRY_RUN=true
  fail(){ printf '%s' "$*"; }
  gate_remote_sync origin`);
  assert.match(output,/local main \(local-sha\) is not synced with origin \(main\) \(remote-sha\)/);
}));

test('tag publication waits for verification of that same event commit',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8');
  const verify=workflow.slice(workflow.indexOf('  verify:'),workflow.indexOf('  publish:'));
  const publish=workflow.slice(workflow.indexOf('  publish:'));
  assert.doesNotMatch(verify,/if:.*ref_type.*branch/);
  assert.match(verify,/npm test/);
  assert.match(verify,/npm run icon/);
  assert.match(publish,/needs: verify/);
  assert.match(publish,/if: github\.ref_type == 'tag' && github\.repository == 'sirouk\/nodecode-vscode'/);
  assert.match(publish,/^    environment: CI$/m);
  assert.doesNotMatch(verify,/^    environment:/m);
  assert.match(publish,/VSCE_PAT: \$\{\{ secrets\.VSCE_PAT \}\}/);
  assert.doesNotMatch(publish,/repo-level Actions SECRET/);
  assert.match(publish,/package-lock\.json version does not match package\.json/);
  assert.doesNotMatch(workflow,/run: npm install/);
  assert.match(workflow,/run: npm ci/);
});

test('release monitor selects the tag push rather than an unrelated branch or release event',()=>{
  const line=script.split('\n').find(line=>line.includes('gh run list --workflow=publish.yml'));
  assert.ok(line);
  assert.match(line,/\.event == "push"/);
  assert.match(line,/\.headBranch == env\.tag/);
  assert.match(line,/tag="\$chosen_tag"/);
  assert.match(script,/git add package\.json package-lock\.json CHANGELOG\.md/);
});
