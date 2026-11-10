#!/bin/bash
# Run from AWS CloudShell in the Mumbai region, in the unpacked Leo folder. Safe to run again for updates.
# Usage: ./deploy/aws-deploy.sh you@example.com
set -euo pipefail
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1
SES_FROM="${1:?Give the email address you verified in Amazon SES}"
STACK=leo

if ! aws ssm get-parameter --name /leo/secret >/dev/null 2>&1; then
  aws ssm put-parameter --name /leo/secret --type SecureString --value "$(openssl rand -base64 48)" >/dev/null
fi

aws cloudformation deploy --stack-name "$STACK" --template-file deploy/cloudformation.yaml --capabilities CAPABILITY_IAM --parameter-overrides AlertEmail="$SES_FROM" --no-fail-on-empty-changeset
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
INSTANCE=$(out InstanceId); IP=$(out PublicIp); BUCKET=$(out BucketName)
DOMAIN="${LEO_DOMAIN:-${IP//./-}.sslip.io}"

tar --exclude=__pycache__ --exclude=.DS_Store -czf /tmp/leo.tar.gz app deploy requirements.txt
aws s3 cp /tmp/leo.tar.gz "s3://$BUCKET/releases/leo.tar.gz" --only-show-errors

aws ec2 wait instance-status-ok --instance-ids "$INSTANCE"
echo "Waiting for the server to report to Systems Manager"
for _ in $(seq 1 40); do
  [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" --query 'length(InstanceInformationList)' --output text)" = "1" ] && break
  sleep 15
done
COMMANDS=$(python3 -c 'import json,sys;print(json.dumps({"commands":[sys.argv[1]]}))' \
  "set -e; apt-get update -qq; apt-get install -y -qq unzip curl >/dev/null; command -v aws >/dev/null || { curl -fsS https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/a.zip; unzip -q -o /tmp/a.zip -d /tmp; /tmp/aws/install; }; export AWS_DEFAULT_REGION=ap-south-1; mkdir -p /opt/leo; aws s3 cp s3://$BUCKET/releases/leo.tar.gz /tmp/leo.tar.gz --only-show-errors; tar -xzf /tmp/leo.tar.gz -C /opt/leo; bash /opt/leo/deploy/install.sh '$DOMAIN' '$BUCKET' '$SES_FROM'")
ID=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --timeout-seconds 1200 --parameters "$COMMANDS" --query Command.CommandId --output text)
echo "Installing on the server. This takes a few minutes."
aws ssm wait command-executed --command-id "$ID" --instance-id "$INSTANCE" || true
aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query '{Status:Status,Output:StandardOutputContent,Errors:StandardErrorContent}' --output text | tail -25
echo "Leo: https://$DOMAIN"
