pipeline {
  agent { label 'lumina-ci' }
  options { skipDefaultCheckout(true); disableConcurrentBuilds(); timeout(time: 60, unit: 'MINUTES'); timestamps() }
  parameters {
    booleanParam(name: 'DEPLOY', defaultValue: false, description: 'Act on protected main after infrastructure has been applied')
    choice(name: 'BACKEND_ACTION', choices: ['deploy', 'tunnel-status', 'tunnel-rotate'],
      description: 'deploy: release this commit. tunnel-status: re-detect and republish the current TEMPORARY Quick Tunnel URL (after an EC2 reboot or cloudflared restart). tunnel-rotate: restart cloudflared to obtain a NEW URL.')
    booleanParam(name: 'TRIGGER_FRONTEND', defaultValue: true, description: 'Then deploy the frontend with the verified API URL (required whenever the tunnel URL changes)')
    string( name: 'FRONTEND_JOB', defaultValue: 'lumina-frontend', description: 'Frontend pipeline job path')
    string(name: 'AWS_REGION', defaultValue: 'us-east-1', description: 'Must match Terraform aws_region')
    string(name: 'VERCEL_ORG_ID', defaultValue: '', description: 'Only for a personal Vercel account (Terraform vercel_team_id is then empty)')
  }
  stages {
    stage('Checkout') {
      steps {
        script {
          def scmVars = checkout scm
          env.GIT_COMMIT = scmVars.GIT_COMMIT
        }
      }
    }
    stage('Runtime') { steps { sh 'bash ci/check-runtime.sh' } }
    stage('Install') { steps { sh 'npm ci' } }
    stage('Tests') { steps { sh 'npm test' } }
    stage('IaC validation') { steps {
      sh 'terraform -chdir=infra/terraform fmt -check -recursive'
      sh 'terraform -chdir=infra/terraform init -backend=false -input=false -lockfile=readonly'
      sh 'terraform -chdir=infra/terraform validate'
      sh 'terraform -chdir=infra/terraform test'
    } }
    stage('Build and verify artifact') {
      when { expression { params.BACKEND_ACTION == 'deploy' } }
      steps { sh 'bash ci/build.sh' }
    }
    stage('Plan, deploy EC2 and verify public API') {
      when { allOf { branch 'main'; not { changeRequest() }; expression { params.DEPLOY } } }
      steps {
        withCredentials([
          // AWS credentials come from the Jenkins EC2 instance IAM role.
          string(credentialsId: 'lumina-vercel-terraform', variable: 'VERCEL_API_TOKEN'),
          file(credentialsId: 'lumina-terraform-backend', variable: 'TF_BACKEND'),
          file(credentialsId: 'lumina-terraform-vars', variable: 'TF_VARS')
        ]) {
          sh '''
            set -eu
            terraform -chdir=infra/terraform init -reconfigure -input=false -backend-config="$TF_BACKEND"
            terraform -chdir=infra/terraform plan -input=false -detailed-exitcode -var-file="$TF_VARS"
            bash ci/deploy.sh "$BACKEND_ACTION"
          '''
        }
      }
    }
    // Backend first, then frontend: the frontend build embeds the API URL that was just verified.
    stage('Deploy frontend with current API URL') {
      when { allOf { branch 'main'; not { changeRequest() }; expression { params.DEPLOY && params.TRIGGER_FRONTEND } } }
      steps {
        script {
          def frontend = [:]
          for (line in readFile('artifacts/frontend.env').trim().split('\n')) {
            def pair = line.split('=', 2)
            frontend[pair[0]] = pair.size() > 1 ? pair[1] : ''
          }
          build job: params.FRONTEND_JOB, wait: true, propagate: true, parameters: [
            booleanParam(name: 'DEPLOY', value: true),
            string(name: 'PUBLIC_API_URL', value: frontend.PUBLIC_API_URL),
            string(name: 'FRONTEND_URL', value: frontend.FRONTEND_URL),
            string(name: 'VERCEL_ORG_ID', value: frontend.VERCEL_ORG_ID),
            string(name: 'VERCEL_PROJECT_ID', value: frontend.VERCEL_PROJECT_ID)
          ]
        }
      }
    }
  }
  post { success { archiveArtifacts artifacts: 'artifacts/*.sha256,artifacts/public-api-url.txt,artifacts/frontend.env', allowEmptyArchive: true, fingerprint: true } }
}
