import readline from 'node:readline';
import chalk from 'chalk';
import * as open from 'open';
import type Client from '../../../util/client';
import { getFlagsSpecification } from '../../../util/get-flags-specification';
import { parseArguments } from '../../../util/get-args';
import handleError from '../../../util/handle-error';
import { help } from '../../help';
import { loginCommand } from './command';
// import { updateCurrentTeamAfterLogin } from '../../../util/login/update-current-team-after-login';
import {
  writeToAuthConfigFile,
  writeToConfigFile,
} from '../../../util/config/files';
import getGlobalPathConfig from '../../../util/config/global-path';
import { getCommandName } from '../../../util/pkg-name';
import { emoji, prependEmoji } from '../../../util/emoji';
import hp from '../../../util/humanize-path';
import {
  deviceAuthorizationRequest,
  processDeviceAuthorizationResponse,
  deviceAccessTokenRequest,
  processDeviceAccessTokenResponse,
  isOAuthError,
} from '../../../util/oauth';

export async function future(client: Client): Promise<number> {
  const { output: o } = client;

  o.warn('This command is not ready yet. Do not use!');

  const flagsSpecification = getFlagsSpecification(loginCommand.options);

  let parsedArgs: ReturnType<
    typeof parseArguments<typeof flagsSpecification>
  > | null = null;
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
    if (!parsedArgs) throw new Error('Could not parse args');
  } catch (error) {
    handleError(error);
    return 1;
  }

  if (parsedArgs.flags['--help']) {
    o.print(help(loginCommand, { columns: client.stderr.columns }));
    return 2;
  }

  const scope = parsedArgs.flags['--scope']?.valueOf();
  o.debug(`Requesting scopes: ${scope?.split(' ').join(', ') ?? 'none'}`);

  const deviceAuthorizationResponse = await deviceAuthorizationRequest({
    scope,
  });

  o.debug(
    `'Device Authorization response:', ${await deviceAuthorizationResponse.clone().text()}`
  );

  const [deviceAuthorizationError, deviceAuthorization] =
    await processDeviceAuthorizationResponse(deviceAuthorizationResponse);

  if (deviceAuthorizationError) {
    handleError(deviceAuthorizationError);
    return 1;
  }

  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expiresAt,
    interval,
  } = deviceAuthorization;

  const rl = readline
    .createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    // HACK: https://github.com/SBoudrias/Inquirer.js/issues/293#issuecomment-172282009, https://github.com/SBoudrias/Inquirer.js/pull/569
    .on('SIGINT', () => process.exit(0));

  rl.question(
    `
  ▲ Sign in to the Vercel CLI

  Visit ${chalk.bold(o.link(verification_uri, verification_uri_complete, { color: false }))} to enter ${chalk.bold(user_code)}
  ${chalk.grey('Press [ENTER] to open the browser')}
`,
    () => {
      open.default(verification_uri_complete);
      rl.close();
    }
  );

  o.spinner('Waiting for authentication...');

  let intervalMs = interval * 1000;
  let error: Error | undefined = new Error(
    'Timed out waiting for authentication. Please try again.'
  );

  async function pollForToken(): Promise<Error | undefined> {
    while (Date.now() < expiresAt) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));

      // TODO: Handle connection timeouts and add interval backoff
      const [tokenResponseError, tokenResponse] =
        await deviceAccessTokenRequest({ device_code });

      if (tokenResponseError) {
        // 2x backoff on connection timeouts per spec https://datatracker.ietf.org/doc/html/rfc8628#section-3.5
        if (tokenResponseError.message.includes('timeout')) {
          intervalMs *= 2;
          o.debug(
            `Connection timeout. Slowing down, polling every ${intervalMs / 1000}s...`
          );
          continue;
        }
        return tokenResponseError;
      }

      o.debug(
        `'Device Access Token response:', ${await tokenResponse.clone().text()}`
      );

      const [tokenError, token] =
        await processDeviceAccessTokenResponse(tokenResponse);

      if (isOAuthError(tokenError)) {
        const { code } = tokenError;
        switch (code) {
          case 'authorization_pending':
            break;
          case 'slow_down':
            intervalMs += 5 * 1000;
            o.debug(
              `Authorization server requests to slow down. Polling every ${intervalMs / 1000}s...`
            );
            break;
          default:
            return tokenError.cause;
        }
      } else if (tokenError) {
        return tokenError;
      } else if (token) {
        // Save the user's authentication token to the configuration file.
        client.authConfig.token = token.access_token;
        error = undefined;
        // TODO: Decide on what to do with the refresh_token

        // TODO: What to do here? The response has no `teamId`
        // if (token.teamId) {
        //   client.config.currentTeam = token.teamId;
        // } else {
        //   delete client.config.currentTeam;
        // }

        // // If we have a brand new login, update `currentTeam`
        // user is not currently authenticated on this machine
        // const isInitialLogin = !client.authConfig.token;
        // if (isInitialLogin) {
        //   await updateCurrentTeamAfterLogin(
        //     client,
        //     o,
        //     client.config.currentTeam
        //   );
        // }

        writeToAuthConfigFile(client.authConfig);
        writeToConfigFile(client.config);

        o.debug(`Saved credentials in "${hp(getGlobalPathConfig())}"`);

        o.print(`
  ${chalk.cyan('Congratulations!')} You are now signed in. In order to deploy something, run ${getCommandName()}.

  ${prependEmoji(
    `Connect your Git Repositories to deploy every branch push automatically (${chalk.bold(o.link('vercel.link/git', 'https://vercel.link/git', { color: false }))}).`,
    emoji('tip')
  )}\n`);

        return;
      }
    }
  }

  error = await pollForToken();

  o.stopSpinner();
  rl.close();

  if (!error) return 0;

  handleError(error);
  return 1;
}