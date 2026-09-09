targetScope = 'resourceGroup'

@minLength(1)
param location string

@minLength(1)
@description('Operator-selected supported SWA location; it can differ from the API location.')
param staticAppsLocation string

@minLength(5)
@maxLength(50)
param registryName string

@minLength(3)
@maxLength(128)
param pullIdentityName string

@minLength(2)
@maxLength(32)
param environmentName string

@minLength(2)
@maxLength(32)
param apiAppName string

@minLength(2)
@maxLength(40)
param siteAppName string

@minLength(2)
@maxLength(40)
param workspaceAppName string

@allowed([
  'Standard'
  'Free'
])
@description('Standard is the production baseline. Free is an explicit development-only option without SLA.')
param staticAppsSku string = 'Standard'

@minLength(1)
param imageRepository string = 'diagnostics'

@minLength(71)
@maxLength(71)
@description('Required existing manifest digest sha256:<64 lowercase hex>. Run Test-Parameters.ps1; Bicep length checks are not a hex validator.')
param imageDigest string

@minLength(1)
@maxLength(4)
@description('Exact HTTPS workspace origins, no wildcard. Temporary SWA hostname requires explicit review.')
param corsOrigins array = [
  'https://tools.domosdigial.com'
]

@minLength(1)
@description('Exact HTTPS API origin, also used by the runtime self-target deny policy.')
param publicApiOrigin string = 'https://api.domosdigial.com'

@description('Preview only: derive exact Azure-generated origins without custom DNS or certificates.')
param useGeneratedOrigins bool = false

@allowed([
  0
  1
])
param minReplicas int = 0

@minValue(1)
@maxValue(10)
param maxReplicas int = 3

@allowed([
  '0.25'
  '0.5'
  '1.0'
])
@description('Paired automatically with 0.5Gi, 1Gi or 2Gi. Small baseline requires measured runtime acceptance.')
param cpuCores string = '0.25'

@minValue(1)
@maxValue(15)
@description('Scale target, not an admission limit. Keep below the verified per-replica in-flight cap.')
param httpConcurrency int = 4

@description('Only after separately approved DNS ownership and certificate issuance. Never creates a certificate.')
param apiCertificateId string = ''

var memoryByCpu = {
  '0.25': '0.5Gi'
  '0.5': '1Gi'
  '1.0': '2Gi'
}

var effectiveCorsOrigins = useGeneratedOrigins ? ['https://${workspace.properties.defaultHostname}'] : corsOrigins
var effectiveApiOrigin = useGeneratedOrigins ? 'https://${apiAppName}.${environment.properties.defaultDomain}' : publicApiOrigin

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: registryName
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: pullIdentityName
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    // The provider requires an absent destination, not the literal string "none".
    appLogsConfiguration: {}
    zoneRedundant: false
  }
}

resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: apiAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 5
      // Pull-only identity: the diagnostics process has no Azure resource access.
      identitySettings: [
        {
          identity: pullIdentity.id
          lifecycle: 'None'
        }
      ]
      registries: [
        {
          server: registry.properties.loginServer
          identity: pullIdentity.id
        }
      ]
      ingress: {
        external: true
        targetPort: 8787
        transport: 'http'
        allowInsecure: false
        customDomains: useGeneratedOrigins || empty(apiCertificateId) ? [] : [
          {
            name: 'api.domosdigial.com'
            bindingType: 'SniEnabled'
            certificateId: apiCertificateId
          }
        ]
      }
    }
    template: {
      terminationGracePeriodSeconds: 30
      containers: [
        {
          name: 'diagnostics'
          image: '${registry.properties.loginServer}/${imageRepository}@${imageDigest}'
          resources: {
            cpu: json(cpuCores)
            memory: memoryByCpu[cpuCores]
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '8787' }
            { name: 'CORS_ORIGINS', value: join(effectiveCorsOrigins, ',') }
            { name: 'PUBLIC_API_ORIGIN', value: effectiveApiOrigin }
            { name: 'PUBLIC_SITE_ORIGIN', value: useGeneratedOrigins ? 'https://${site.properties.defaultHostname}' : 'https://domosdigial.com' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 8787, scheme: 'HTTP' }
              initialDelaySeconds: 1
              periodSeconds: 3
              timeoutSeconds: 2
              failureThreshold: 10
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8787, scheme: 'HTTP' }
              initialDelaySeconds: 1
              periodSeconds: 5
              timeoutSeconds: 2
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8787, scheme: 'HTTP' }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 2
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        cooldownPeriod: 300
        pollingInterval: 30
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(httpConcurrency)
              }
            }
          }
        ]
      }
    }
  }
}

resource site 'Microsoft.Web/staticSites@2024-11-01' = {
  name: siteAppName
  location: staticAppsLocation
  sku: {
    name: staticAppsSku
    tier: staticAppsSku
  }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
  }
}

resource workspace 'Microsoft.Web/staticSites@2024-11-01' = {
  name: workspaceAppName
  location: staticAppsLocation
  sku: {
    name: staticAppsSku
    tier: staticAppsSku
  }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
  }
}

output apiDefaultOrigin string = 'https://${api.properties.configuration.ingress.fqdn}'
output apiDomainVerificationId string = api.properties.customDomainVerificationId
output siteDefaultOrigin string = 'https://${site.properties.defaultHostname}'
output workspaceDefaultOrigin string = 'https://${workspace.properties.defaultHostname}'
output apiImage string = '${registry.properties.loginServer}/${imageRepository}@${imageDigest}'
