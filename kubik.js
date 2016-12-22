'use strict';
// TODO: display uncaught exception in a popup

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const blessed  = require('blessed'),
      contrib  = require('blessed-contrib'),
      moment   = require('moment'),
      duration = require('moment-duration-format'),
      task     = require('./libs/task'),
      fs       = require('fs'),
      os       = require('os'),
      path     = require('path'),
      yaml     = require('js-yaml'),
      screen   = blessed.screen();

const session = {
  cancellations: new task.Cancellations(),
  namespace    : 'default',
  namespaces   : {},
  pod          : null,
  pods         : {}
};

const kube_config = getKubeConfig(process.argv[2] || process.env.KUBERNETES_MASTER);
session.namespace = kube_config.context.namespace || 'default';
const master_api  = getMasterApi(kube_config);

// TODO: support client access information provided as CLI options
// TODO: better context disambiguation workflow
// see:
// - http://kubernetes.io/docs/user-guide/accessing-the-cluster/
// - http://kubernetes.io/docs/user-guide/kubeconfig-file/
function getKubeConfig(master) {
  // TODO: check if the file exists and can be read first
  const kube = yaml.safeLoad(fs.readFileSync(path.join(os.homedir(), '.kube/config'), 'utf8'));
  let cluster, context, current, user;
  if (!master) {
    // TODO: error exit in case no current context is set
    current = kube['current-context'];
    context = kube.contexts.find(item => item.name === current).context;
    cluster = kube.clusters.find(item => item.cluster.server === context.cluster).cluster;
  } else {
    cluster = kube.clusters.find(item => item.cluster.server === master);
    context = kube.contexts.find(item => item.context.cluster === cluster.name).context;
    cluster = cluster.cluster;
  }
  user = kube.users.find(user => user.name === context.user).user;
  return {cluster, context, user};
}

function getMasterApi(kube_config) {
  const {cluster, user}              = kube_config;
  const [, protocol, hostname, port] = /^(\w+:)\/\/([^:]+):(\d*)$/.exec(cluster.server);
  // TODO: add a helper to retrieve the URL
  const master_api                   = {
    protocol, hostname, port,
    headers: {
      'Accept': 'application/json, text/plain, */*'
    }
  };
  if (cluster['insecure-skip-tls-verify']) {
    master_api.rejectUnauthorized = true;
  }
  // TODO: support 'client-key-data', 'client-certificate-data' and 'certificate-authority-data'
  if (user['client-certificate']) {
    master_api.cert = fs.readFileSync(user['client-certificate']);
  }
  if (user['client-key']) {
    master_api.key = fs.readFileSync(user['client-key']);
  }
  if (user.token) {
    master_api.headers['Authorization'] = `Bearer ${user.token}`;
  }
  if (cluster['certificate-authority']) {
    master_api.ca = fs.readFileSync(cluster['certificate-authority']);
  }
  return master_api;
}

const get_apis = () => Object.assign({
  path  : '/',
  method: 'GET'
}, master_api);

// https://docs.openshift.org/latest/architecture/additional_concepts/authentication.html
// https://github.com/openshift/openshift-docs/issues/707
const oauth_authorize = () => Object.assign({
  path  : '/oauth/authorize?client_id=openshift-challenging-client&response_type=token',
  method: 'GET',
  // TODO: support passing credentials as command line options
  // TODO: prompt for credentials
  auth  : 'admin:admin'
}, master_api);

// TODO: get projects instead of namespaces for OpenShift
const get_namespaces = () => Object.assign({
  path  : '/api/v1/namespaces',
  method: 'GET'
}, master_api);

const get_pods = (namespace) => Object.assign({
  path  : `/api/v1/namespaces/${namespace}/pods`,
  method: 'GET'
}, master_api);

const watch_pods = (namespace, resourceVersion) => Object.assign({
  path  : `/api/v1/namespaces/${namespace}/pods?watch=true&resourceVersion=${resourceVersion}`,
  method: 'GET'
}, master_api);

const get_logs = (namespace, pod, sinceTime) => Object.assign({
  // we may want to adapt the amount of lines based on the widget height
  path  : `/api/v1/namespaces/${namespace}/pods/${pod}/log?follow=true&tailLines=25&timestamps=true` + (sinceTime ? `&sinceTime=${sinceTime}` : ''),
  method: 'GET'
}, master_api);

const grid = new contrib.grid({rows: 12, cols: 12, screen: screen});

const pods_table = grid.set(0, 0, 6, 6, blessed.listtable, {
  border       : 'line',
  align        : 'left',
  keys         : true,
  tags         : true,
  shrink       : false,
  noCellBorders: true,
  // FIXME: margin isn't incremented for child list in scrollable list table
  scrollbar    : {
    ch   : ' ',
    style: {bg: 'white'},
    track: {
      style: {bg: 'black'}
    }
  },
  style        : {
    border: {fg: 'white'},
    header: {fg: 'blue', bold: true},
    cell  : {fg: 'white', selected: {bg: 'blue'}}
  }
});

pods_table.on('select', (item, i) => {
  // FIXME: logs resources are not available for pods in non running state
  const pod = session.pods.items[i - 1].metadata.name;
  if (pod === session.pod)
    return;
  session.cancellations.run('dashboard.logs');
  session.pod = pod;
  setTableData(session.pods);
  pod_logs.setLabel('Logs');
  pod_logs.logLines = [];
  pod_logs.setItems([]);
  screen.render();

  let sinceTime;
  const logger = function*() {
    let log, timestamp;
    try {
      while (log = yield) {
        log       = log.toString('utf8');
        const i   = log.indexOf(' ');
        timestamp = log.substring(0, i);
        const msg = log.substring(i + 1);
        // avoid scanning the whole buffer if the timestamp differs from the since time
        if (!timestamp.startsWith(sinceTime) || !pod_logs.logLines.includes(msg))
          pod_logs.log(msg);
      }
    } catch (e) {
      // TODO: find a way to delegate the retry logic to a separate generator with yield*
      // log 'follow' requests close after an hour, so let's retry the request...
      // sub-second info from the 'sinceTime' parameter are not taken into account
      sinceTime                     = timestamp.substring(0, timestamp.indexOf('.'));
      const {promise, cancellation} = get(get_logs(session.namespace, pod, timestamp), logger);
      session.cancellations.add('dashboard.logs', cancellation);
      promise.catch(error => console.error(error.stack));
    }
  };

  // FIXME: deal with multi-containers pod
  const {promise, cancellation} = get(get_logs(session.namespace, pod), logger);
  session.cancellations.add('dashboard.logs', cancellation);
  promise
    .then(() => pod_logs.setLabel(`Logs {grey-fg}[${pod}]{/grey-fg}`))
    .then(() => screen.render())
    .catch(error => console.error(error.stack));
});
// work-around for https://github.com/chjj/blessed/issues/175
pods_table.on('remove', () => pods_table.removeLabel());
pods_table.on('prerender', () => pods_table.setLabel('Pods'));

function setTableData(pods) {
  const selected = pods_table.selected;
  pods_table.setData(pods.items.reduce((data, pod) => {
    data.push([
      pod.metadata.name === session.pod ? `{blue-fg}${pod.metadata.name}{/blue-fg}` : pod.metadata.name,
      // TODO: be more fine grained for the status
      // TODO: add a visual hint depending on the status
      pod.status.phase,
      // FIXME: negative duration is displayed when pod starts as clocks may not be synced
      formatDuration(moment.duration(moment().diff(moment(pod.status.startTime))))
    ]);
    return data;
  }, [['NAME', 'STATUS', 'AGE']]));
  pods_table.select(selected);
}

function formatDuration(duration) {
  if (duration.years() > 0)
    return duration.format('y[y] M[M]');
  else if (duration.months() > 0)
    return duration.format('M[M] d[d]');
  else if (duration.days() > 0)
    return duration.format('d[d] h[h]');
  else if (duration.hours() > 0)
    return duration.format('h[h] m[m]');
  else if (duration.minutes() > 0)
    return duration.format('m[m] s[s]');
  else
    return duration.format('s[s]');
}

// TODO: enable user scrolling
const pod_logs = grid.set(6, 0, 6, 12, contrib.log, {
  border      : 'line',
  align       : 'left',
  label       : 'Logs',
  tags        : true,
  style       : {
    border: {fg: 'white'}
  },
  bufferLength: 50
});

const debug = grid.set(0, 0, 12, 12, contrib.log, {
  label       : 'Logs',
  style       : {
    fg    : 'white',
    border: {fg: 'white'}
  },
  bufferLength: 100
});

// TODO: display a list table with some high level info about the namespaces
const namespaces_list = blessed.list({
  top      : 'center',
  left     : 'center',
  width    : '50%',
  height   : '50%',
  label    : 'Namespaces',
  keys     : true,
  tags     : true,
  border   : {type: 'line'},
  scrollbar: {
    ch   : ' ',
    style: {bg: 'white'},
    track: {
      style: {bg: 'black'}
    }
  },
  style    : {
    fg      : 'white',
    border  : {fg: 'white'},
    selected: {bg: 'blue'}
  }
});
namespaces_list.on('cancel', () => {
  namespaces_list.detach();
  screen.render();
});
namespaces_list.on('select', (item, i) => {
  namespaces_list.detach();
  screen.render();
  const namespace = session.namespaces.items[i].metadata.name;
  if (namespace === session.namespace)
    return;
  // cancel current running tasks and open requests
  debug.log(`Cancelling background tasks for namespace ${session.namespace}`);
  session.cancellations.run('dashboard');
  // reset dashboard widgets
  pods_table.clearItems();
  pod_logs.setLabel('Logs');
  pod_logs.logLines = [];
  pod_logs.setItems([]);
  // switch dashboard to new namespace
  session.namespace = namespace;
  session.pod       = null;
  debug.log(`Switching to namespace ${session.namespace}`);
  screen.render();
  dashboard().catch(error => console.error(error.stack));
});

screen.key(['n'], () => {
  screen.append(namespaces_list);
  namespaces_list.clearItems();
  namespaces_list.focus();
  screen.render();
  // TODO: watch for namespace changes when the selection list is open
  get(get_namespaces())
    .then(response => JSON.parse(response.body.toString('utf8')))
    .then(namespaces => session.namespaces = namespaces)
    .then(namespaces => namespaces_list.setItems(namespaces.items.reduce((data, namespace) => {
      data.push(namespace.metadata.name === session.namespace ?
        `{blue-fg}${namespace.metadata.name}{/blue-fg}` : namespace.metadata.name);
      return data;
    }, [])))
    .then(() => screen.render())
    .catch(error => console.error(error.stack));
});

screen.key(['q', 'C-c'], (ch, key) => process.exit(0));

const carousel = new contrib.carousel([screen => {
  // TODO: restore selection if any
  screen.append(pods_table);
  screen.append(pod_logs);
  pods_table.focus();
}, screen => screen.append(debug)], {
  screen     : screen,
  interval   : 0,
  controlKeys: true
});
carousel.start();

// TODO: log more about client access workflow and info
dashboard()
  .catch(error => {
    if (error.response && error.response.statusCode === 403) {
      // fallback to manual authentication
      authenticate()
        .then(dashboard)
        .catch(error => console.error(error.stack));
    } else {
      console.error(error.stack);
    }
    // TODO: better error management
  });

function authenticate() {
  // retrieve the list of available API endpoints
  return get(get_apis())
    .then(response => {
      const paths = JSON.parse(response.body.toString('utf8')).paths;
      const oapi  = paths.some(path => path === '/oapi' || path === '/oapi/v1');
      // check if it's an OpenShift cluster
      if (oapi) {
        // then try retrieving an OAuth access token from the OpenShift OAuth endpoint
        return get(oauth_authorize())
          .then(response => response.headers.location.match(/access_token=([^&]+)/)[1])
          .then(token => master_api.headers['Authorization'] = `Bearer ${token}`);
      } else {
        throw new Error(`Unable to authenticate to ${master_api.protocol}://${master_api.hostname}:${master_api.port}`);
      }
    })
}

function dashboard() {
  return get(get_pods(session.namespace))
    .then(response => {
      session.pods       = JSON.parse(response.body.toString('utf8'));
      session.pods.items = session.pods.items || [];
    })
    .then(() => setTableData(session.pods))
    .then(() => debug.log(`Watching for pods changes in namespace ${session.namespace} ...`))
    .then(() => screen.render())
    .then(() => {
      const id = setInterval(refreshPodAges, 1000);
      session.cancellations.add('dashboard.refreshPodAges', () => clearInterval(id));
    })
    .then(() => {
      const {promise, cancellation} = get(watch_pods(session.namespace, session.pods.metadata.resourceVersion), updatePodTable);
      session.cancellations.add('dashboard', cancellation);
      return promise;
    });
}

function* updatePodTable() {
  let change, buffer = '';
  while (change = yield) {
    buffer += change.toString('utf8');
    try {
      change = JSON.parse(buffer);
      buffer = '';
    } catch (error) {
      continue
    }
    const index = object => session.pods.items.findIndex(pod => pod.metadata.uid === object.metadata.uid);
    switch (change.type) {
      case 'ADDED':
        session.pods.items.push(change.object);
        break;
      case 'MODIFIED':
        session.pods.items[index(change.object)] = change.object;
        break;
      case 'DELETED':
        // TODO: check if that's the selected pod and remove selection / cancel logs
        session.pods.items.splice(index(change.object), 1);
        break;
    }
    setTableData(session.pods);
    screen.render();
  }
  // TODO: find a way to delegate the retry logic to a separate generator with yield*
  // watch requests are closed after an hour (or 'timeoutSeconds') by Kubernetes,
  // so let's retry watching for pods...
  session.cancellations.run('dashboard.refreshPodAges');
  dashboard().catch(error => console.error(error.stack));
}

function refreshPodAges() {
  session.pods.items.forEach(pod => moment(pod.status.startTime).add(1, 's').toISOString());
  // we may want to avoid recreating the whole table data
  setTableData(session.pods);
  screen.render();
}

function get(options, generator, async = true) {
  return generator ? getStream(options, generator, async) : getBody(options);
}

// we may want to support cancellation of the returned pending promise
function getBody(options) {
  return new Promise((resolve, reject) => {
    const client = (options.protocol || 'http').startsWith('https') ? require('https') : require('http');
    client.get(options, response => {
      if (response.statusCode >= 400) {
        const error    = new Error(`Failed to get resource ${options.path}, status code: ${response.statusCode}`);
        // standard promises don't handle multi-parameters reject callbacks
        error.response = response;
        response.destroy(error);
        return;
      }
      const body = [];
      response
        .on('data', chunk => body.push(chunk))
        .on('end', () => {
          response.body = Buffer.concat(body);
          resolve(response);
        });
    }).on('error', reject);
  })
}

// TODO: deal with WebSocket protocol upgrade event
function getStream(options, generator, async = true) {
  let request, clientAbort, serverAbort;
  const promise = new Promise((resolve, reject) => {
    const client = (options.protocol || 'http').startsWith('https') ? require('https') : require('http');
    request      = client.get(options, response => {
      if (response.statusCode >= 400) {
        const error    = new Error(`Failed to get resource ${options.path}, status code: ${response.statusCode}`);
        // standard promises don't handle multi-parameters reject callbacks
        error.response = response;
        response.destroy(error);
        return;
      }
      const gen = generator();
      gen.next();

      response
        .on('aborted', () => serverAbort = !clientAbort)
        .on('data', chunk => {
          const res = gen.next(chunk);
          if (res.done) {
            // we may work on the http.ClientRequest if needed
            response.destroy();
            response.body = res.value;
            // ignored for async as it's already been resolved
            resolve(response);
          }
        })
        .on('end', () => {
          if (serverAbort || clientAbort && !async) {
            try {
              // FIXME: what happens when the generator is done already?
              const res = gen.throw(new Error('Request aborted'));
              // the generator may have already returned from the 'data' event
              if (!async && !res.done) {
                response.body = res.value;
                resolve(response);
              }
            } catch (e) {
              if (!async) {
                reject(e);
              }
              // else swallow for generators that ignore aborted requests
            }
          } else if (!(clientAbort && async)) {
            const res = gen.next();
            // the generator may have already returned from the 'data' event
            if (!async && !res.done) {
              response.body = res.value;
              resolve(response);
            }
          }
          // ignored if the generator is done already
          gen.return();
        });

      if (async) {
        resolve(response);
      }
    }).on('error', reject)
      .on('abort', () => clientAbort = true);
  });
  return {
    promise     : promise,
    // destroy the http.ClientRequest on cancellation
    cancellation: request ? () => request.abort() : () => void 0
  }
}