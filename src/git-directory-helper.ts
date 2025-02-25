import * as assert from 'assert'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as fsHelper from './fs-helper'
import * as io from '@actions/io'
import * as path from 'path'
import {IGitCommandManager} from './git-command-manager'
import {execSync} from 'child_process'

function getUserName(uid: number): string {
  try {
    return execSync(`id -un ${uid}`).toString().trim()
  } catch (error) {
    return uid.toString()
  }
}

// Function to get group name from gid
function getGroupName(gid: number): string {
  try {
    return execSync(`id -gn ${gid}`).toString().trim()
  } catch (error) {
    return gid.toString()
  }
}

async function listDirectory(dirPath: string): Promise<void> {
  try {
    // Read directory contents
    const files = await fs.promises.readdir(dirPath)

    // Get details for each file
    const filesInfo = await Promise.all(
      files.map(async file => {
        const filePath = path.join(dirPath, file)
        const stats = await fs.promises.stat(filePath)

        // Get user and group info
        const owner = getUserName(stats.uid)
        const group = getGroupName(stats.gid)

        return {
          name: file,
          size: stats.size,
          mode: stats.mode,
          mtime: stats.mtime,
          isDirectory: stats.isDirectory(),
          owner,
          group
        }
      })
    )

    // Format and print like ls -la
    core.info(`total ${filesInfo.length}`)
    for (const file of filesInfo) {
      const mode = file.isDirectory ? 'd' : '-'
      const permissions = (file.mode & 0o777).toString(8)
      const date = file.mtime.toDateString()
      core.info(
        `${mode}${permissions} ${file.owner.padEnd(8)} ${file.group.padEnd(8)} ` +
          `${file.size.toString().padStart(8)} ${date} ${file.name}`
      )
    }
  } catch (error) {
    core.info(`Error reading directory: ${error}`)
  }
}

export async function prepareExistingDirectory(
  git: IGitCommandManager | undefined,
  repositoryPath: string,
  repositoryUrl: string,
  clean: boolean,
  ref: string
): Promise<void> {
  assert.ok(repositoryPath, 'Expected repositoryPath to be defined')
  assert.ok(repositoryUrl, 'Expected repositoryUrl to be defined')

  // Indicates whether to delete the directory contents
  let remove = false

  await listDirectory('/home/runner/cache/repositories/factorialco')
  await listDirectory(repositoryPath)

  // Check whether using git or REST API
  if (!git) {
    core.info(`Setting remove = true because !git`)
    remove = true
  }
  // Fetch URL does not match
  else if (
    !fsHelper.directoryExistsSync(path.join(repositoryPath, '.git')) ||
    repositoryUrl !== (await git.tryGetFetchUrl())
  ) {
    const fetchUrl = await git.tryGetFetchUrl()
    core.info(`Setting remove = true because no .git or git.tryGetFetchUrl()`)
    core.info(`RepositoryUrl: ${repositoryUrl}`)
    core.info(`tryGetFetchUrl: ${fetchUrl}`)
    remove = true
  } else {
    // Delete any index.lock and shallow.lock left by a previously canceled run or crashed git process
    const lockPaths = [
      path.join(repositoryPath, '.git', 'index.lock'),
      path.join(repositoryPath, '.git', 'shallow.lock')
    ]
    for (const lockPath of lockPaths) {
      try {
        await io.rmRF(lockPath)
      } catch (error) {
        core.debug(
          `Unable to delete '${lockPath}'. ${(error as any)?.message ?? error}`
        )
      }
    }

    try {
      core.startGroup('Removing previously created refs, to avoid conflicts')
      // Checkout detached HEAD
      if (!(await git.isDetached())) {
        await git.checkoutDetach()
      }

      // Remove all refs/heads/*
      let branches = await git.branchList(false)
      for (const branch of branches) {
        await git.branchDelete(false, branch)
      }

      // Remove any conflicting refs/remotes/origin/*
      // Example 1: Consider ref is refs/heads/foo and previously fetched refs/remotes/origin/foo/bar
      // Example 2: Consider ref is refs/heads/foo/bar and previously fetched refs/remotes/origin/foo
      if (ref) {
        ref = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`
        if (ref.startsWith('refs/heads/')) {
          const upperName1 = ref.toUpperCase().substr('REFS/HEADS/'.length)
          const upperName1Slash = `${upperName1}/`
          branches = await git.branchList(true)
          for (const branch of branches) {
            const upperName2 = branch.substr('origin/'.length).toUpperCase()
            const upperName2Slash = `${upperName2}/`
            if (
              upperName1.startsWith(upperName2Slash) ||
              upperName2.startsWith(upperName1Slash)
            ) {
              await git.branchDelete(true, branch)
            }
          }
        }
      }
      core.endGroup()

      // Check for submodules and delete any existing files if submodules are present
      if (!(await git.submoduleStatus())) {
        remove = true
        core.info('Bad Submodules found, removing existing files')
      }

      // Clean
      if (clean) {
        core.startGroup('Cleaning the repository')
        if (!(await git.tryClean())) {
          core.debug(
            `The clean command failed. This might be caused by: 1) path too long, 2) permission issue, or 3) file in use. For further investigation, manually run 'git clean -ffdx' on the directory '${repositoryPath}'.`
          )
          core.info(`Setting remove = true because clean failed`)
          remove = true
        } else if (!(await git.tryReset())) {
          core.info(`Setting remove = true because reset failed`)
          remove = true
        }
        core.endGroup()

        if (remove) {
          core.warning(
            `Unable to clean or reset the repository. The repository will be recreated instead.`
          )
        }
      }
    } catch (error) {
      core.warning(
        `Unable to prepare the existing repository. The repository will be recreated instead.`
      )
      core.info(`Setting remove = true because try - catch`)
      remove = true
    }
  }

  if (remove) {
    // Delete the contents of the directory. Don't delete the directory itself
    // since it might be the current working directory.
    core.info(`Deleting the contents of '${repositoryPath}'`)
    for (const file of await fs.promises.readdir(repositoryPath)) {
      await io.rmRF(path.join(repositoryPath, file))
    }
  }
}
