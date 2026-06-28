
# Getting secrets needed to call Google APIs

This application interacts with Google Drive APIs, so it needs a Google-issued CLIENT_ID and CLIENT_SECRET. Those values should be stored in a file called ".env".

Steps to get those values are as follows:
1. Go to https://cloud.google.com/cloud-console and create a new application. Ppen that app for configuration.
2. Visit the "APIs & Services > Enabled APIs & services" section of the cloud console and added the "Google Drive API".
3. Visit the "APIs & Services > Credentials" section of the cloud console and create an "OAuth 2.0 Client ID"
    a. Specify that the application type is "Desktop app"
    b. Set the name to the "UUFRC Backup client" (or whatever you like)
    c. At the end of the process, download a JSON file that contains a "client_id" property and a "client_secret" property
4. Store those values in the .env file, following the pattern shown in .env.example.

Initially, this app can only be used by the user who created it. The app is configured in "testing" mode, so it can only be executed by explicitly-named Google users. To add a new user, return to the Google Cloud console, find the "Google Auth Platform" section, and select the "Audience" subsection. Add the user's gmail address.
   
# Building this application

To download and build this app, do the following:
1. Install Node.js, if you have not done so already
2. In a terminal window, navigate to the directory where the application has been downloaded.
3. Type "npm install"

To run this app, do the following:

```
# Create an installable Mac DMG file
$ npm run build-mac

# Create a Windows installer
$ npm run build-win

# Run the node.js application without creating an installable app
$ npm run start
```

# Files that are read/written by this application

When the application runs, it stores information (including the user's refresh token) in the following directory. If you wish to fully reset the application to a clean slate, then delete that directory. The user will need to sign-in again.

```
macOS application data:
~/Library/Application Support/uufrcBackup

Windows application data:
C:\Users\<YourUsername>\AppData\Local\uufrcBackup
```

Every time that this application executes, it writes status information to a log file. Location:

```
macOS log file:
~/Library/Logs/uufrcBackup/main.log

Windows log file:
C:\Users\<YourUsername>\AppData\Local\uufrcBackup\logs\main.log
```

# Possible future enhancements

Enhancements that could be added to this application in the future are listed in this section.

## Better observability

If an error occurs, a dialog window instructs the user to contact IT. A member of the technical committee can read the log file to gather diagnostic information.

There is more that we could do to enable remote users to verify that this application is running correctly. One idea is to send an email message every time that it completes successfully.

## Record deleted/unshared files

Whenever this app makes a copy of a file to the backup folder, an entry is added to a backup.csv file that is stored in Google Drive.

The purpose of this backup is to ensure that we never lose access to a file, even if the file is no longer shared with this user. We could try to detect when a previously-backed-up file is no longer shared with this user, and that information could be added to the backup.csv file.

## Provide a means to flag image/video/audio files for backup

To conserve space, we do not backup image, video, or audio files. We are concerned that some member of the church will upload a large number of images to their committee's directory, and the result is that we'll use up all the storage in the backup account. Perhaps we should provide some means for users to tag image/video/audio files that should be backed up.








